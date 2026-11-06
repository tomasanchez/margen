"""Reader port for the receivables query side (ADR-204, ADR-206, ADR-130).

The reader serves the people list and the per-person detail with settlement roll-ups, the
default allocation of a payment over what a person owes (ADR-221), and the owner's expense
search behind the receivable link picker (ADR-220). It is strictly read-only — receivables
writes go through commands on the unit of work (ADR-028) — and is owner-scoped so a caller
only ever sees their own people and expenses (ADR-130). The concrete adapter lives under
``margen_api.adapters``.

Outstanding is a function of time once cuotas exist (ADR-215): every roll-up is computed as of
the ``as_of`` date the caller passes in — the boundary injects "today" — so the due/upcoming
split is deterministic and testable (ADR-223).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date
from decimal import Decimal
from uuid import UUID

from margen_api.service_layer.receivable_read_models import (
    ExpenseCandidateReadModel,
    PersonDetailReadModel,
    PersonReadModel,
    SuggestedAllocationReadModel,
)


class AbstractReceivableReader(ABC):
    """Async, read-only query port for people and their outstanding balances (ADR-204)."""

    @abstractmethod
    async def list_people(self, user_id: str, *, as_of: date) -> list[PersonReadModel]:
        """List the owner's people with outstanding totals, newest-first by creation (ADR-130).

        Args:
            user_id: The authenticated owner; every person is scoped to it so a caller
                only sees their own (ADR-108, ADR-130).
            as_of: The date due-ness is assessed on (ADR-215).

        Returns:
            The owner's people with their due-only outstanding and upcoming totals,
            newest-first.
        """

    @abstractmethod
    async def get_person(self, person_id: UUID, user_id: str, *, as_of: date) -> PersonDetailReadModel | None:
        """Load one person with per-item (and per-cuota) roll-ups, or ``None`` (ADR-206, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the boundary
        then answers 404 (ADR-111).

        Args:
            person_id: The person identity.
            user_id: The authenticated owner the person must belong to.
            as_of: The date due-ness is assessed on (ADR-215).

        Returns:
            The person detail with its items and roll-ups, or ``None`` when absent for
            this owner.
        """

    @abstractmethod
    async def suggest_allocation(
        self,
        person_id: UUID,
        user_id: str,
        *,
        amount: Decimal,
        as_of: date,
    ) -> SuggestedAllocationReadModel | None:
        """Spread a payment amount over what the person owes now, the ADR-221 default.

        Due cuotas oldest first, then open flat items (see
        :func:`~margen_api.domain.models.receivable_settlement.default_allocation`); the UI
        prefills its allocation form with it and the owner may still edit it.

        Args:
            person_id: The paying person.
            user_id: The authenticated owner the person must belong to.
            amount: The payment amount to spread.
            as_of: The date due-ness is assessed on (ADR-215).

        Returns:
            The suggested allocation, or ``None`` when the person is absent for this owner.
        """

    @abstractmethod
    async def search_expense_candidates(
        self,
        user_id: str,
        *,
        query: str | None,
        date_from: date | None,
        date_to: date | None,
        limit: int,
    ) -> list[ExpenseCandidateReadModel]:
        """Search the owner's expenses a receivable item may link to (ADR-217, ADR-220).

        Only the owner's own ``kind='expense'`` transactions are candidates. Already-linked
        expenses are NOT hidden — one expense may back many items (ADR-218) — but each carries
        the total its linked items already add up to.

        Args:
            user_id: The authenticated owner.
            query: A case-insensitive fragment of the expense name, or ``None`` for any.
            date_from: The earliest ``occurred_on`` to include, or ``None``.
            date_to: The latest ``occurred_on`` to include, or ``None``.
            limit: The maximum number of candidates to return.

        Returns:
            The matching expenses, newest first.
        """
