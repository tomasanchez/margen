"""Owner-scoped reader feeding the fuzzy income-match suggestions (ADR-207, ADR-130).

The read-only query side of the receivable income matcher: for one of the owner's people
it fetches the candidate ``kind='income'`` transactions, then hands them to the PURE
:func:`~margen_api.service_layer.receivable_matcher.rank_income_matches` for scoring and
ranking. SQLAlchemy stays in this adapter (AGENTS.md); the matcher stays a plain,
I/O-free function — this reader only does the I/O and the composition.

Three ADR-207 boundaries are enforced in SQL before a single candidate is scored:

1. **Owner scoping** — every candidate income and the person itself are filtered by
   ``user_id`` (ADR-108, ADR-130); a foreign or unknown person yields no suggestions
   rather than leaking existence (ADR-111).
2. **Date window** — only incomes whose ``occurred_on`` is on or after the person's
   EARLIEST ``receivable_item.occurred_on`` are considered (ADR-207). The item date — not
   the person's ``created_at`` — is the boundary, because a person may be added to the app
   after their earliest debt was recorded, and a matching income can predate that
   data-entry timestamp. A person with no items has no window and yields nothing.
3. **Claimed exclusion** — an income already linked to a ``receivable_payment`` (its
   ``matched_income_transaction_id``) is "claimed" and never re-suggested for any of the
   owner's people (ADR-207).

The reader never mutates state, so it is wired independently of the unit of work. It reads
the transactions table read-only and never joins into ``account_queries`` — receivables
never enter net worth (ADR-205). All I/O is awaited.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Kind
from margen_api.service_layer.receivable_match_reader import AbstractReceivableMatchReader
from margen_api.service_layer.receivable_matcher import (
    IncomeMatch,
    IncomeMatchCandidate,
    rank_income_matches,
)


class SqlAlchemyReceivableMatchReader(AbstractReceivableMatchReader):
    """Suggest a person's likely income matches from an async session (ADR-207, ADR-130).

    Fetches the owner-scoped, date-windowed, unclaimed income pool and delegates the
    scoring/ranking to the pure matcher. Read-only.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def suggest_income_matches(self, person_id: UUID, user_id: str) -> list[IncomeMatch]:
        """Rank the owner's unclaimed incomes that plausibly match a person (ADR-207, ADR-130).

        Loads the person (owner-scoped), determines the earliest-item date window, excludes
        already-claimed incomes, and scores the remaining candidate incomes against the
        person's name via the pure matcher.

        Args:
            person_id: The debtor whose paybacks to find income matches for.
            user_id: The authenticated owner; the person, the incomes and the claimed set
                are all scoped to it (ADR-108, ADR-130).

        Returns:
            The matching incomes as scored, ranked :class:`IncomeMatch` records, best-first;
            an empty list when the person is absent for this owner, has no items (no date
            window), or no unclaimed income clears the match threshold.
        """
        owner = UUID(user_id)

        person = (
            await self.session.execute(
                select(PersonRecord).where(
                    PersonRecord.id == person_id,
                    PersonRecord.user_id == owner,
                )
            )
        ).scalar_one_or_none()
        if person is None:
            # Unknown or foreign person: no suggestions, existence never leaked (ADR-111).
            return []

        earliest_item_date = (
            await self.session.execute(
                select(func.min(ReceivableItemRecord.occurred_on)).where(
                    ReceivableItemRecord.person_id == person_id,
                )
            )
        ).scalar_one_or_none()
        if earliest_item_date is None:
            # No items means no receivable to match against and no date window (ADR-207).
            return []

        claimed = await self._claimed_income_ids(owner)
        candidates = await self._candidate_incomes(owner, earliest_item_date, claimed)
        return rank_income_matches(person.name, candidates)

    async def _claimed_income_ids(self, owner: UUID) -> set[UUID]:
        """Return the income ids already linked to one of the owner's payments (ADR-207).

        A claimed income is any ``kind='income'`` transaction already referenced by a
        ``receivable_payment.matched_income_transaction_id`` under this owner; it must not
        be re-suggested for any of the owner's people. Scoped to the owner by joining the
        payment back to its person (the only ownership column, ADR-130).
        """
        statement = (
            select(ReceivablePaymentRecord.matched_income_transaction_id)
            .join(PersonRecord, PersonRecord.id == ReceivablePaymentRecord.person_id)
            .where(
                PersonRecord.user_id == owner,
                ReceivablePaymentRecord.matched_income_transaction_id.is_not(None),
            )
        )
        rows = (await self.session.execute(statement)).scalars().all()
        return {income_id for income_id in rows if income_id is not None}

    async def _candidate_incomes(
        self,
        owner: UUID,
        earliest_item_date: object,
        claimed: set[UUID],
    ) -> list[IncomeMatchCandidate]:
        """Project the owner's windowed, unclaimed income rows into match candidates (ADR-207).

        Selects ``kind='income'`` transactions owned by ``owner`` (ADR-108) whose
        ``occurred_on`` is on or after ``earliest_item_date`` (ADR-207) and whose id is not
        in the ``claimed`` set. The claimed filter is only applied when non-empty so the
        query never renders an empty ``IN`` clause.
        """
        predicates = [
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.INCOME.value,
            TransactionRecord.occurred_on >= earliest_item_date,
        ]
        if claimed:
            predicates.append(TransactionRecord.id.not_in(claimed))
        statement = select(
            TransactionRecord.id,
            TransactionRecord.name,
            TransactionRecord.amount,
            TransactionRecord.occurred_on,
        ).where(*predicates)
        rows = (await self.session.execute(statement)).all()
        return [
            IncomeMatchCandidate(
                transaction_id=row.id,
                name=row.name,
                amount=row.amount,
                occurred_on=row.occurred_on,
            )
            for row in rows
        ]
