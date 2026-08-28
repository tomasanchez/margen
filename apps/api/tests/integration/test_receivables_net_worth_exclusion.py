"""Integration proof that receivables never move balance or net worth (ADR-205).

Marked ``integration`` (ADR-032): runs only against a real PostgreSQL with the receivables
tables present, and is excluded from the coverage gate. ADR-205 makes receivables
exclusion from net worth STRUCTURAL — the four tables carry no ``account_id`` and are never
read by :class:`~margen_api.adapters.account_queries.SqlAlchemyAccountReader`. This test is
the executable proof ADR-205 asks for: it computes an owner's net worth + every per-account
balance as a baseline, then creates a full receivables subtree for that SAME owner through
the real handlers — a person, two items, a manual payment, a ``matched_income`` payment
linked to a real income transaction, AND an overpayment credit — and asserts the net-worth
surface is byte-identical to the baseline. The receivable rows are counted afterwards so the
equality is never vacuously true (the data really exists), and the baseline is asserted to a
concrete non-zero total so a reader that errored or returned an empty surface could not make
the two "equal" by both being empty.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.account_queries import SqlAlchemyAccountReader
from margen_api.adapters.account_repository import SqlAlchemyAccountRepository
from margen_api.adapters.institution_repository import SqlAlchemyInstitutionRepository
from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableAllocationRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
    CreatePerson,
    RecordReceivablePayment,
)
from margen_api.domain.models.account import build_account
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind, PaymentSource
from margen_api.service_layer.receivables import (
    add_receivable_item,
    create_person,
    record_receivable_payment,
)

pytestmark = pytest.mark.integration

OWNER = "99999999-9999-4999-8999-999999999999"

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)
# Everything is dated in the past so the as-of-today net-worth snapshot (ADR-186) is stable
# across the two reads even if the suite happens to straddle midnight UTC.
_TODAY = datetime.now(UTC).date()
_PAST = _TODAY - timedelta(days=30)


def _tx(**overrides: object):
    """Build a transaction with sensible ARS/past defaults for the baseline assets."""
    defaults: dict[str, object] = {
        "transaction_id": uuid4(),
        "occurred_on": _PAST,
        "name": "Movement",
        "kind": Kind.EXPENSE,
        "amount": Decimal("0"),
        "user_id": OWNER,
        "created_at": _MOMENT,
        "updated_at": _MOMENT,
    }
    defaults.update(overrides)
    return build_transaction(**defaults)  # type: ignore[arg-type]


async def _seed_account(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    currency: Currency = Currency.ARS,
    opening_balance: Decimal = Decimal("0"),
) -> UUID:
    """Persist an institution + account for ``OWNER`` and return the account id."""
    async with session_factory() as session:
        institution = build_institution(name="Galicia", type=InstitutionType.BANK, user_id=OWNER)
        SqlAlchemyInstitutionRepository(session).add(institution)
        await session.flush()
        account = build_account(
            institution_id=institution.id,
            currency=currency,
            opening_balance=opening_balance,
            user_id=OWNER,
        )
        SqlAlchemyAccountRepository(session).add(account)
        await session.commit()
        return account.id


async def _seed_transactions(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist the given transaction aggregates in one committed session."""
    async with session_factory() as session:
        repo = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repo.add(row)
        await session.commit()


async def _receivable_counts(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, int]:
    """Return the row counts of each receivables table, so the equality is never vacuous."""
    async with session_factory() as session:
        return {
            "people": await _count(session, PersonRecord),
            "items": await _count(session, ReceivableItemRecord),
            "payments": await _count(session, ReceivablePaymentRecord),
            "allocations": await _count(session, ReceivableAllocationRecord),
        }


async def _count(session: AsyncSession, record: type) -> int:
    """Return the number of rows in ``record``'s table."""
    return int((await session.execute(select(func.count()).select_from(record))).scalar_one())


class TestReceivablesDoNotAffectNetWorth:
    """Creating a full receivables subtree moves neither net worth nor any balance (ADR-205)."""

    async def test_net_worth_is_byte_identical_before_and_after_receivables(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN an owner with ARS + USD accounts and transactions (a concrete, non-zero
              baseline net worth)
        WHEN a full receivables subtree is created for that SAME owner — a person, two
             items, a manual payment, a matched_income payment linked to a real income
             transaction, and an overpayment credit
        THEN the net-worth surface (total, currency, every per-account balance, liabilities
             and net_after_liabilities) is byte-identical to the baseline — receivables move
             nothing (ADR-205)
        """
        # GIVEN — an ARS account (opening 100000) carrying a real income (+50000, later the
        # matched-income target) and an expense (-20000), plus a USD account (opening 0)
        # holding a 100 USD income that also seeds the 1000 ARS/USD MEP rate.
        ars_account = await _seed_account(session_factory, opening_balance=Decimal("100000"))
        usd_account = await _seed_account(session_factory, currency=Currency.USD, opening_balance=Decimal("0"))
        income_id = uuid4()
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    transaction_id=income_id,
                    name="Juan repayment",
                    kind=Kind.INCOME,
                    amount=Decimal("50000"),
                    account_id=ars_account,
                ),
                _tx(name="Groceries", kind=Kind.EXPENSE, amount=Decimal("20000"), account_id=ars_account),
                _tx(
                    name="Deel payout",
                    kind=Kind.INCOME,
                    amount=Decimal("100000"),
                    currency=Currency.USD,
                    usd_amount=Decimal("100"),
                    fx_rate=Decimal("1000"),
                    fx_source="mep",
                    account_id=usd_account,
                ),
            ],
        )

        # AND — the baseline net worth BEFORE any receivable exists.
        async with session_factory() as session:
            baseline = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # AND — the baseline is a concrete, non-empty surface: the reader really computed it,
        # so a later "equal" cannot be two empty/errored surfaces coinciding.
        by_id_baseline = {account.id: account for account in baseline.accounts}
        assert len(baseline.accounts) == 2
        assert by_id_baseline[ars_account].balance == Decimal("130000.00")  # 100000 + 50000 - 20000
        assert by_id_baseline[usd_account].balance == Decimal("100.00")  # native USD
        assert baseline.total == Decimal("230000.00")  # 130000 ARS + 100 USD @ 1000
        assert baseline.currency is Currency.ARS
        assert baseline.liabilities.total == Decimal("0.00")

        # WHEN — a full receivables subtree is created for the SAME owner.
        uow = SqlAlchemyUnitOfWork(session_factory)
        person_id = await create_person(CreatePerson(user_id=OWNER, name="Juan"), uow)
        item_one = await add_receivable_item(
            AddReceivableItem(user_id=OWNER, person_id=person_id, occurred_on=_PAST, amount=Decimal("10000")), uow
        )
        item_two = await add_receivable_item(
            AddReceivableItem(user_id=OWNER, person_id=person_id, occurred_on=_PAST, amount=Decimal("5000")), uow
        )
        # A manual payback (4000 of item_one).
        await record_receivable_payment(
            RecordReceivablePayment(
                user_id=OWNER,
                person_id=person_id,
                occurred_on=_PAST,
                amount=Decimal("4000"),
                allocations=(AllocationInput(item_id=item_one, amount=Decimal("4000")),),
            ),
            uow,
        )
        # A matched_income payback (the remaining 6000 of item_one) linked to the real income
        # transaction — the ADR-207 seam, still with no account_id and no balance effect.
        await record_receivable_payment(
            RecordReceivablePayment(
                user_id=OWNER,
                person_id=person_id,
                occurred_on=_PAST,
                amount=Decimal("6000"),
                allocations=(AllocationInput(item_id=item_one, amount=Decimal("6000")),),
                source=PaymentSource.MATCHED_INCOME,
                matched_income_transaction_id=income_id,
            ),
            uow,
        )
        # An overpayment credit against item_two (8000 > the 5000 owed) — a confirmed credit
        # that drives the person's outstanding below zero (ADR-206). Even this moves nothing.
        await record_receivable_payment(
            RecordReceivablePayment(
                user_id=OWNER,
                person_id=person_id,
                occurred_on=_PAST,
                amount=Decimal("8000"),
                allocations=(AllocationInput(item_id=item_two, amount=Decimal("8000")),),
                allow_overpayment=True,
            ),
            uow,
        )

        # AND — the receivables really were persisted, so the equality below is meaningful.
        counts = await _receivable_counts(session_factory)
        assert counts == {"people": 1, "items": 2, "payments": 3, "allocations": 3}

        # AND — net worth read AGAIN, now with the whole receivables subtree present.
        async with session_factory() as session:
            with_receivables = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — the entire net-worth surface is byte-identical: receivables move nothing.
        assert with_receivables == baseline
        # AND — the money figures match to the exact string form (no exponent/scale drift).
        assert str(with_receivables.total) == str(baseline.total)
        assert with_receivables.net_after_liabilities == baseline.net_after_liabilities
        assert with_receivables.liabilities.total == baseline.liabilities.total
        by_id_after = {account.id: account for account in with_receivables.accounts}
        for account_id, before in by_id_baseline.items():
            after = by_id_after[account_id]
            assert after.balance == before.balance
            assert str(after.balance) == str(before.balance)
            assert after.balance_converted == before.balance_converted
