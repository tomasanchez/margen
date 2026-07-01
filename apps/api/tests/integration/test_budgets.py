"""Integration tests for budgets against real PostgreSQL (ADR-125).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is set
and a real PostgreSQL is reachable, and are excluded from the coverage gate. They
prove what the mocked fast tiers cannot on the production dialect:

* the upsert handler replaces an existing target for a category/month in place —
  driven against the real ``UNIQUE(user_id, category, period)`` constraint, so a
  duplicate would raise rather than silently double the target (ADR-125);
* the budgets reader joins the owner's per-category targets with the month's real
  per-category expense spend (the same aggregation the summaries reader uses,
  ADR-042) into ``target`` / ``spent`` / ``remaining`` lines, scoped to the owner.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.budget_queries import SqlAlchemyBudgetReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.budget import ApplySavingProfile, UpsertBudget, UpsertBudgetIncome
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.budget_handlers import apply_saving_profile, upsert_budget, upsert_budget_income

pytestmark = pytest.mark.integration

OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"
JUNE = date(2026, 6, 1)
_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _expense(occurred_on: date, amount: str, category: str, *, user_id: str = OWNER):
    """Build an ARS expense aggregate for a date, category and owner."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=f"{category} spend",
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category=category,
        user_id=user_id,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _line(lines, category: str):
    """Return the budget line for a category from the read model's lines."""
    return next(line for line in lines if line.category == category)


class TestBudgetUpsert:
    """The upsert replaces a target in place against the real UNIQUE constraint."""

    async def test_repeated_upsert_replaces_not_duplicates(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a Food target set for June
        WHEN the same category/month is upserted again with a new amount
        THEN the reader sees exactly one Food target carrying the replaced amount
             (the UNIQUE(user_id, category, period) constraint backs the upsert)
        """
        # GIVEN / WHEN
        await upsert_budget(
            UpsertBudget(user_id=OWNER, category="Food", period=JUNE, amount=Decimal("50000")),
            SqlAlchemyUnitOfWork(session_factory),
        )
        await upsert_budget(
            UpsertBudget(user_id=OWNER, category="Food", period=JUNE, amount=Decimal("75000")),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # THEN
        session = session_factory()
        try:
            model = await SqlAlchemyBudgetReader(session).monthly_budget(JUNE, OWNER)
            await session.rollback()
        finally:
            await session.close()
        food_lines = [line for line in model.categories if line.category == "Food"]
        assert len(food_lines) == 1
        assert food_lines[0].target == Decimal("75000.00")


class TestBudgetReader:
    """The reader joins targets with the real per-category month spend (ADR-042)."""

    async def test_pairs_target_with_spend_and_scopes_to_owner(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a Food target, a Food expense in June, and another owner's Food expense
        WHEN the owner's June budgets surface is read
        THEN Food carries target, the owner's spend and remaining; the other owner's
             expense never leaks into the spend, and an unbudgeted category reads null
        """
        # GIVEN — seed expenses for two owners.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            repository.add(_expense(date(2026, 6, 5), "20000.00", "Food"))
            repository.add(_expense(date(2026, 6, 6), "8000.00", "Transport"))
            repository.add(_expense(date(2026, 6, 7), "999999.00", "Food", user_id=OTHER_OWNER))
            await session.commit()
        # GIVEN — a Food target for the owner.
        await upsert_budget(
            UpsertBudget(user_id=OWNER, category="Food", period=JUNE, amount=Decimal("50000")),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # WHEN
        session = session_factory()
        try:
            model = await SqlAlchemyBudgetReader(session).monthly_budget(JUNE, OWNER)
            await session.rollback()
        finally:
            await session.close()

        # THEN — Food: target + owner-only spend + remaining.
        food = _line(model.categories, "Food")
        assert food.target == Decimal("50000.00")
        assert food.spent == Decimal("20000.00")  # the other owner's 999999 is excluded
        assert food.remaining == Decimal("30000.00")
        # The stored native currency surfaces from the target's own row (ADR-152/155).
        assert food.target_currency == "ARS"
        # Transport has spend but no target -> null target/remaining/currency.
        transport = _line(model.categories, "Transport")
        assert transport.target is None
        assert transport.spent == Decimal("8000.00")
        assert transport.remaining is None
        assert transport.target_currency is None


class TestCategoryHistoryReader:
    """The history reader averages the three real months before the requested one (ADR-145)."""

    async def test_aggregates_three_prior_months_scoped_to_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN Food expenses in 2026-03/-04/-05 for the owner and another owner's May Food
        WHEN the owner's June history is read
        THEN Food's avg3mo is the mean of the three months, lastMonth is May's spend, and
             the other owner's expense never leaks (ADR-108)
        """
        # GIVEN — the three calendar months before June, plus a foreign owner's May spend.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            repository.add(_expense(date(2026, 3, 10), "30000.00", "Food"))
            repository.add(_expense(date(2026, 4, 10), "60000.00", "Food"))
            repository.add(_expense(date(2026, 5, 10), "90000.00", "Food"))
            repository.add(_expense(date(2026, 5, 12), "999999.00", "Food", user_id=OTHER_OWNER))
            await session.commit()

        # WHEN
        session = session_factory()
        try:
            history = await SqlAlchemyBudgetReader(session).category_history(JUNE, OWNER)
            await session.rollback()
        finally:
            await session.close()

        # THEN — mean(30000, 60000, 90000) = 60000; last = May's 90000; foreign owner excluded.
        food = next(line for line in history.categories if line.category == "Food")
        assert food.avg3mo == Decimal("60000.00")
        assert food.last_month == Decimal("90000.00")


class TestBudgetKindReader:
    """The kind discriminator keeps spend/saving distinct against the real schema (ADR-138)."""

    async def test_saving_rows_never_leak_into_categories(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an income base, a Food spend target and an applied Balanced profile
        WHEN the owner's budgets surface is read
        THEN savings carry the buckets, categories carry only spend, and no saving
             bucket leaks into the vs-actuals categories (the widened UNIQUE + the
             kind='spend' reader filter, ADR-138)
        """
        # GIVEN — an income base, a spend target, and a saving profile, all real SQL.
        await upsert_budget_income(
            UpsertBudgetIncome(user_id=OWNER, period=JUNE, amount=Decimal("1000000")),
            SqlAlchemyUnitOfWork(session_factory),
        )
        await upsert_budget(
            UpsertBudget(user_id=OWNER, category="Food", period=JUNE, amount=Decimal("50000")),
            SqlAlchemyUnitOfWork(session_factory),
        )
        await apply_saving_profile(
            ApplySavingProfile(user_id=OWNER, period=JUNE, profile="balanced"),
            SqlAlchemyUnitOfWork(session_factory),
        )

        # WHEN
        session = session_factory()
        try:
            model = await SqlAlchemyBudgetReader(session).monthly_budget(JUNE, OWNER)
            await session.rollback()
        finally:
            await session.close()

        # THEN — savings populated, the spend target present, and no leak.
        bucket_names = {line.bucket for line in model.savings}
        assert "EmergencyFund" in bucket_names
        category_names = {line.category for line in model.categories}
        assert category_names.isdisjoint(bucket_names)
        food = _line(model.categories, "Food")
        assert food.target == Decimal("50000.00")
