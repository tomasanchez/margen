"""Integration tests for transfers against real PostgreSQL (ADR-135).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is set
and a real PostgreSQL is reachable, and are excluded from the coverage gate. They
prove what the mocked fast tiers cannot on the production dialect:

* the per-account balance / net-worth aggregation unions transactions + transfers
  (``+amount_in`` to the destination, ``-amount_out`` from the source), in each
  account's native currency, conserving total net worth for a same-currency transfer
  (ADR-135);
* a transfer plus its "Fees" expenses leave the Monotributo trailing-12-month total
  (``used``) unchanged — transfers are not transactions and fees are EXPENSE rows the
  Monotributo SUM filters out (ADR-046, ADR-135) — while net worth drops by the fee.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.account_queries import SqlAlchemyAccountReader
from margen_api.adapters.queries import SqlAlchemyMonotributoReader
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.transfer import CreateTransfer, TransferFeeInput
from margen_api.domain.models.account import build_account
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind
from margen_api.service_layer.transfer_handlers import create_transfer

pytestmark = pytest.mark.integration

REFERENCE = date(2026, 6, 14)
A_DATE = date(2026, 6, 12)
_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)
OWNER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


async def _seed_account(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    currency: Currency,
    opening_balance: str,
):
    """Persist one institution + account for the owner and return the account."""
    institution = build_institution(
        institution_id=uuid4(),
        name="Galicia",
        type=InstitutionType.BANK,
        user_id=OWNER,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )
    account = build_account(
        account_id=uuid4(),
        institution_id=institution.id,
        currency=currency,
        opening_balance=Decimal(opening_balance),
        user_id=OWNER,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )
    uow = SqlAlchemyUnitOfWork(session_factory)
    async with uow:
        uow.institutions.add(institution)
        # Flush so the institution row exists before the account's FK resolves;
        # SQLAlchemy does not order these two unrelated inserts on its own.
        await uow.flush()
        uow.accounts.add(account)
        await uow.commit()
    return account


async def _balances_by_id(session_factory: async_sessionmaker[AsyncSession]) -> dict:
    """Return the owner's net-worth per-account breakdown keyed by account id.

    The read-only session is rolled back before close so its connection does not
    return to the pool ``idle in transaction`` and block the fixture's ``drop_all``.
    """
    session = session_factory()
    try:
        net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)
        await session.rollback()
    finally:
        await session.close()
    return {account.id: account for account in net_worth.accounts}


async def _monotributo_used(session_factory: async_sessionmaker[AsyncSession], reference: date) -> Decimal:
    """Return the owner's Monotributo trailing-12-month total (``used``) for a reference.

    The read-only session is rolled back before close so its connection does not
    return to the pool ``idle in transaction`` and block the fixture's ``drop_all``.
    """
    session = session_factory()
    try:
        standing = await SqlAlchemyMonotributoReader(session).current_standing(reference, OWNER)
        await session.rollback()
    finally:
        await session.close()
    return standing.used


class TestTransferBalanceIntegration:
    """The balance / net-worth aggregation unions transactions + transfers (ADR-135)."""

    async def test_same_currency_transfer_moves_balances_net_zero(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN two ARS accounts (opening 10000 and 0)
        WHEN a 2500 net-zero transfer is recorded
        THEN the source drops to 7500, the destination rises to 2500, and the total
             net worth is conserved (ADR-135)
        """
        # GIVEN
        source = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="10000")
        destination = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="0")

        # WHEN
        await create_transfer(
            CreateTransfer(
                user_id=OWNER,
                from_account_id=source.id,
                to_account_id=destination.id,
                amount_out=Decimal("2500"),
                amount_in=Decimal("2500"),
                occurred_on=A_DATE,
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN
        balances = await _balances_by_id(session_factory)
        assert balances[source.id].balance == Decimal("7500.00")
        assert balances[destination.id].balance == Decimal("2500.00")

    async def test_cross_currency_transfer_moves_native_amounts(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a USD account (opening 1000) and an ARS account (opening 0)
        WHEN 100 USD is sent out and 95000 ARS received
        THEN each account moves in its own native currency (ADR-123, ADR-135)
        """
        # GIVEN
        usd = await _seed_account(session_factory, currency=Currency.USD, opening_balance="1000")
        ars = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="0")

        # WHEN
        await create_transfer(
            CreateTransfer(
                user_id=OWNER,
                from_account_id=usd.id,
                to_account_id=ars.id,
                amount_out=Decimal("100"),
                amount_in=Decimal("95000"),
                occurred_on=A_DATE,
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN
        balances = await _balances_by_id(session_factory)
        assert balances[usd.id].balance == Decimal("900.00")
        assert balances[ars.id].balance == Decimal("95000.00")


class TestTransferMonotributoIsolation:
    """A transfer + its fees never touch the Monotributo total (ADR-046, ADR-135)."""

    async def test_transfer_and_fees_leave_used_unchanged_but_reduce_net_worth(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a counted invoice income and two accounts
        WHEN a transfer with a fee is recorded
        THEN the Monotributo trailing-12-month total (used) is unchanged while net
             worth drops by exactly the fee (ADR-046 unaffected, ADR-135)
        """
        # GIVEN — configure the owner's category and record a counted invoice.
        async with SqlAlchemyUnitOfWork(session_factory) as uow:
            await uow.settings.upsert_settings(
                OWNER,
                monotributo_current_category="A",
                monotributo_activity_type="services",
            )
            await uow.commit()
        source = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="1000000")
        destination = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="0")
        invoice = build_transaction(
            transaction_id=uuid4(),
            occurred_on=A_DATE,
            name="Consulting invoice",
            kind=Kind.INVOICE,
            amount=Decimal("1500000"),
            currency=Currency.ARS,
            category="Consulting",
            counts_toward_monotributo=True,
            account_id=source.id,
            user_id=OWNER,
            created_at=_MOMENT,
            updated_at=_MOMENT,
        )
        async with SqlAlchemyUnitOfWork(session_factory) as uow:
            uow.transactions.add(invoice)
            await uow.commit()

        used_before = await _monotributo_used(session_factory, REFERENCE)
        net_before = sum(account.balance for account in (await _balances_by_id(session_factory)).values())

        # WHEN — a transfer with a 5000 ARS fee on the source.
        await create_transfer(
            CreateTransfer(
                user_id=OWNER,
                from_account_id=source.id,
                to_account_id=destination.id,
                amount_out=Decimal("250000"),
                amount_in=Decimal("250000"),
                occurred_on=A_DATE,
                fees=(TransferFeeInput(account_id=source.id, amount=Decimal("5000"), label="Transfer fee"),),
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN — Monotributo total is untouched; net worth dropped by exactly the fee.
        # Route through the helper (rollback + close) so the read-only session does not
        # return to the pool ``idle in transaction`` and deadlock the fixture's drop_all.
        used_after = await _monotributo_used(session_factory, REFERENCE)
        net_after = sum(account.balance for account in (await _balances_by_id(session_factory)).values())
        assert used_after == used_before
        assert net_before - net_after == Decimal("5000.00")


class TestTransferFeeFxSnapshotIntegration:
    """A fee's FX snapshot round-trips through the real transaction store (ADR-148/149)."""

    async def test_fee_with_fx_snapshot_persists_materialized_usd_amount(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a transfer whose ARS fee carries an FX snapshot (fx_rate + fx_source)
        WHEN the transfer is recorded and the fee expense is read back from PostgreSQL
        THEN usd_amount is materialized (= round(amount / rate, 2)) and the rate +
             source persist exactly like a normal expense (ADR-148, ADR-149)
        """
        # GIVEN
        source = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="10000")
        destination = await _seed_account(session_factory, currency=Currency.ARS, opening_balance="0")

        # WHEN — a 3000 ARS fee stamped with a MEP rate of 1000 ARS per USD.
        result = await create_transfer(
            CreateTransfer(
                user_id=OWNER,
                from_account_id=source.id,
                to_account_id=destination.id,
                amount_out=Decimal("2500"),
                amount_in=Decimal("2500"),
                occurred_on=A_DATE,
                fees=(
                    TransferFeeInput(
                        account_id=source.id,
                        amount=Decimal("3000"),
                        label="Transfer fee",
                        fx_rate=Decimal("1000"),
                        fx_source="mep",
                    ),
                ),
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN — the fee expense round-trips its materialized USD snapshot.
        fee_id = result.fee_transaction_ids[0]
        async with SqlAlchemyUnitOfWork(session_factory) as uow:
            fee = await uow.transactions.get(fee_id, OWNER)
        assert fee is not None
        assert fee.usd_amount == Decimal("3.00")  # 3000 / 1000
        assert fee.fx_rate == Decimal("1000")
        assert fee.fx_source == "mep"
