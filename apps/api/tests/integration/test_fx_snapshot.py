"""Integration tests for the FX-snapshot money model against real PostgreSQL.

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is set
and a real PostgreSQL is reachable, and are excluded from the coverage gate. They
prove what the mocked fast tiers cannot on the production dialect:

* the create write path materializes ``usd_amount = round(amount ÷ fx_rate, 2)`` when
  a snapshot (fx_rate + fx_source) is supplied, and leaves it null otherwise
  (ADR-148, ADR-149);
* the snapshot setter (``set_transaction_fx_snapshot``) re-materializes ``usd_amount``
  on an existing row and is owner-scoped (a cross-tenant id is not found, ADR-108/111);
* the settings ``preferred_rate_source`` field defaults to 'bolsa' and round-trips
  (ADR-151);
* the budgets reader sums ``usd_amount`` for USD budgets, excludes null-snapshot rows,
  and reports the unconverted count (ADR-152); the relaxed income suggestion estimates
  from available months and sums the USD snapshot (ADR-152, ADR-153).

Reader sessions follow the rollback()+close() teardown discipline so a leaked session
never holds a lock that would hang the tier's drop_all (conftest).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.budget_income_queries import SqlAlchemyBudgetIncomeReader
from margen_api.adapters.budget_queries import SqlAlchemyBudgetReader
from margen_api.adapters.queries import SqlAlchemyTransactionReader
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.budget import UpsertBudget
from margen_api.domain.commands.settings import UpdateSettings
from margen_api.domain.commands.transaction import CreateTransaction, SetTransactionFxSnapshot
from margen_api.domain.models.exceptions import TransactionNotFoundError
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.budget_handlers import upsert_budget
from margen_api.service_layer.handlers import create_transaction, set_transaction_fx_snapshot
from margen_api.service_layer.settings_handlers import update_settings

pytestmark = pytest.mark.integration

OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"
JUNE = date(2026, 6, 1)
A_DATE = date(2026, 6, 12)


async def _create_usd_expense(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    amount: str,
    category: str = "Food",
    fx_rate: Decimal | None = None,
    fx_source: str | None = None,
    user_id: str = OWNER,
    kind: Kind = Kind.EXPENSE,
):
    """Create a USD transaction through the real handler and return its id."""
    return await create_transaction(
        CreateTransaction(
            user_id=user_id,
            occurred_on=A_DATE,
            name=f"{category} usd",
            kind=kind,
            amount=Decimal(amount),
            currency=Currency.USD,
            category=category,
            fx_rate=fx_rate,
            fx_source=fx_source,
        ),
        SqlAlchemyUnitOfWork(session_factory),
    )


async def _read_transaction(session_factory: async_sessionmaker[AsyncSession], transaction_id, owner: str = OWNER):
    """Read one transaction read model back through the query reader (rollback+close)."""
    session = session_factory()
    try:
        model = await SqlAlchemyTransactionReader(session).get_transaction(transaction_id, owner)
        await session.rollback()
    finally:
        await session.close()
    return model


class TestCreateMaterializesSnapshot:
    """The create write path materializes usd_amount from amount ÷ rate (ADR-148, ADR-149)."""

    async def test_snapshot_materializes_usd_amount(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD create carrying a snapshot (rate + source)
        WHEN it is created through the real handler
        THEN usd_amount is stored as round(amount ÷ rate, 2) and the source persists
        """
        # GIVEN / WHEN — 50000 ARS @ 1000 ARS/USD -> 50.00 USD.
        transaction_id = await _create_usd_expense(
            session_factory, amount="50000", fx_rate=Decimal("1000"), fx_source="bolsa"
        )

        # THEN
        model = await _read_transaction(session_factory, transaction_id)
        assert model is not None
        assert model.usd_amount == Decimal("50.00")
        assert model.fx_rate == Decimal("1000.000000")
        assert model.fx_source == "bolsa"

    async def test_no_rate_leaves_snapshot_null(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD create with no snapshot (no rate, no source)
        WHEN it is created
        THEN usd_amount / fx_rate / fx_source are all null (ADR-149 import-pending)
        """
        # GIVEN / WHEN
        transaction_id = await _create_usd_expense(session_factory, amount="50000")

        # THEN
        model = await _read_transaction(session_factory, transaction_id)
        assert model is not None
        assert model.usd_amount is None
        assert model.fx_rate is None
        assert model.fx_source is None

    async def test_half_up_rounding(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an amount that does not divide evenly by the rate
        WHEN the snapshot materializes
        THEN usd_amount rounds HALF_UP to two decimals (12345 / 1000 -> 12.35)
        """
        # GIVEN / WHEN
        transaction_id = await _create_usd_expense(
            session_factory, amount="12345", fx_rate=Decimal("1000"), fx_source="bolsa"
        )

        # THEN
        model = await _read_transaction(session_factory, transaction_id)
        assert model is not None
        assert model.usd_amount == Decimal("12.35")


class TestSetSnapshot:
    """The snapshot setter re-materializes usd_amount and is owner-scoped (ADR-148, ADR-111)."""

    async def test_sets_snapshot_on_existing_row(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD row created without a snapshot
        WHEN the snapshot setter applies a rate + source
        THEN usd_amount is materialized and the source persists
        """
        # GIVEN
        transaction_id = await _create_usd_expense(session_factory, amount="50000")

        # WHEN
        await set_transaction_fx_snapshot(
            SetTransactionFxSnapshot(id=transaction_id, user_id=OWNER, fx_rate=Decimal("1000"), fx_source="backfill"),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN
        model = await _read_transaction(session_factory, transaction_id)
        assert model is not None
        assert model.usd_amount == Decimal("50.00")
        assert model.fx_source == "backfill"

    async def test_cross_tenant_snapshot_is_not_found(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD row owned by another user
        WHEN OWNER tries to set its snapshot
        THEN a TransactionNotFoundError is raised and the row is untouched (ADR-108/111)
        """
        # GIVEN — a row owned by OTHER_OWNER.
        transaction_id = await _create_usd_expense(session_factory, amount="50000", user_id=OTHER_OWNER)

        # WHEN / THEN — OWNER cannot snapshot it (a cross-tenant id is not found).
        with pytest.raises(TransactionNotFoundError):
            await set_transaction_fx_snapshot(
                SetTransactionFxSnapshot(id=transaction_id, user_id=OWNER, fx_rate=Decimal("1000")),
                SqlAlchemyUnitOfWork(session_factory),
            )

        # THEN — the row stays unsnapshotted for its real owner.
        model = await _read_transaction(session_factory, transaction_id, owner=OTHER_OWNER)
        assert model is not None
        assert model.usd_amount is None


class TestSettingsPreferredRateSource:
    """The preferred_rate_source setting defaults to 'bolsa' and round-trips (ADR-151)."""

    async def test_default_is_bolsa(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN no settings row
        WHEN the owner's settings are read
        THEN the preferred rate source is the documented default 'bolsa'
        """
        # WHEN
        session = session_factory()
        try:
            settings = await SqlAlchemySettingsRepository(session).get_settings(OWNER)
            await session.rollback()
        finally:
            await session.close()

        # THEN
        assert settings.preferred_rate_source == "bolsa"

    async def test_round_trips_oficial(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an update setting the preferred rate source to 'oficial'
        WHEN it is persisted and read back
        THEN the value round-trips through the real app_settings row
        """
        # GIVEN / WHEN
        await update_settings(
            UpdateSettings(user_id=OWNER, preferred_rate_source="oficial"),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN
        session = session_factory()
        try:
            settings = await SqlAlchemySettingsRepository(session).get_settings(OWNER)
            await session.rollback()
        finally:
            await session.close()
        assert settings.preferred_rate_source == "oficial"


class TestUsdBudgetSpend:
    """USD budgets sum usd_amount, exclude null snapshots and count unconverted (ADR-152)."""

    async def test_usd_spend_sums_snapshot_and_counts_unconverted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN one snapshotted USD expense and one without a snapshot in Food
        WHEN the USD budget surface is read
        THEN spent sums only the snapshot and unconverted counts the other (ADR-152)
        """
        # GIVEN
        await _create_usd_expense(session_factory, amount="50000", fx_rate=Decimal("1000"), fx_source="bolsa")
        await _create_usd_expense(session_factory, amount="30000")
        await upsert_budget(
            UpsertBudget(user_id=OWNER, category="Food", period=JUNE, amount=Decimal("200"), currency="USD"),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # WHEN
        session = session_factory()
        try:
            model = await SqlAlchemyBudgetReader(session).monthly_budget(JUNE, OWNER, Currency.USD)
            await session.rollback()
        finally:
            await session.close()

        # THEN — only the snapshotted 50.00 is summed; the other is unconverted.
        assert model.currency is Currency.USD
        food = next(line for line in model.categories if line.category == "Food")
        assert food.spent == Decimal("50.00")
        assert food.target == Decimal("200.00")
        assert food.remaining == Decimal("150.00")
        assert model.unconverted == 1

    async def test_ars_default_unchanged(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD expense with no snapshot
        WHEN the ARS budget surface is read (default currency)
        THEN spend sums the authoritative amount and unconverted is 0 (ADR-152)
        """
        # GIVEN
        await _create_usd_expense(session_factory, amount="50000")

        # WHEN
        session = session_factory()
        try:
            model = await SqlAlchemyBudgetReader(session).monthly_budget(JUNE, OWNER)
            await session.rollback()
        finally:
            await session.close()

        # THEN
        assert model.currency is Currency.ARS
        food = next(line for line in model.categories if line.category == "Food")
        assert food.spent == Decimal("50000.00")
        assert model.unconverted == 0


class TestUsdSuggestedBase:
    """The relaxed income suggestion estimates from available months and sums USD (ADR-152/153)."""

    async def test_usd_suggestion_sums_snapshot_inflow(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one snapshotted USD income month and one without a snapshot
        WHEN the USD suggested base is read
        THEN it estimates from the single snapshotted month (ADR-152, ADR-153)
        """
        # GIVEN — June USD income 100000 ARS @ 1000 -> 100.00 USD; May USD income no snapshot.
        await create_transaction(
            CreateTransaction(
                user_id=OWNER,
                occurred_on=date(2026, 6, 10),
                name="Deel",
                kind=Kind.INCOME,
                amount=Decimal("100000"),
                currency=Currency.USD,
                fx_rate=Decimal("1000"),
                fx_source="bolsa",
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )
        await create_transaction(
            CreateTransaction(
                user_id=OWNER,
                occurred_on=date(2026, 5, 10),
                name="Deel",
                kind=Kind.INCOME,
                amount=Decimal("50000"),
                currency=Currency.USD,
            ),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # WHEN
        session = session_factory()
        try:
            suggested = await SqlAlchemyBudgetIncomeReader(session).suggested_base(JUNE, OWNER, Currency.USD)
            await session.rollback()
        finally:
            await session.close()

        # THEN — only the snapshotted month counts: a single USD month of 100.00.
        assert suggested.suggested_base == Decimal("100.00")
        assert suggested.months_available == 1
        assert suggested.is_sparse is True
        assert suggested.currency is Currency.USD
