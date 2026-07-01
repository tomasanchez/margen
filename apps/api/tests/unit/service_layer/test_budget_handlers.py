"""Unit tests for the budget application handlers (ADR-125, ADR-130).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
They verify the upsert handler inserts a fresh target, replaces an existing one for
the same category/month rather than duplicating it (the UNIQUE semantics, ADR-125),
preserves identity and ``created_at`` on a replace, scopes by owner (ADR-130), and
that the clear handler deletes a target and is idempotent when none exists.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.domain.commands.budget import (
    ApplySavingProfile,
    ClearBudget,
    RepriceMonth,
    UpsertBudget,
    UpsertBudgetIncome,
)
from margen_api.domain.models.budget import build_budget
from margen_api.domain.models.budget_income import build_budget_income
from margen_api.domain.models.exceptions import MissingIncomeBaseError
from margen_api.domain.models.value_objects import BudgetKind
from margen_api.service_layer.budget_handlers import (
    apply_saving_profile,
    clear_budget,
    reprice_month,
    upsert_budget,
    upsert_budget_income,
)
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"
JUNE = date(2026, 6, 1)
JULY = date(2026, 7, 1)


class TestUpsertBudgetHandler:
    """The upsert handler inserts or replaces a single per-category monthly target."""

    async def test_inserts_a_new_target(self):
        """
        GIVEN no existing target for a category/month
        WHEN the upsert handler runs
        THEN a new owned target is committed and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = UpsertBudget(user_id=A_USER, category="Food", period=JUNE, amount=Decimal("50000"))

        # WHEN
        budget_id = await upsert_budget(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_budgets[budget_id]
        assert stored.user_id == A_USER
        assert stored.category == "Food"
        assert stored.period == JUNE
        assert stored.amount == Decimal("50000")

    async def test_replaces_existing_target_without_duplicating(self):
        """
        GIVEN an existing target for a category/month
        WHEN the upsert handler runs for the same category/month with a new amount
        THEN the amount is replaced in place — no duplicate row, identity preserved
        """
        # GIVEN
        existing = build_budget(
            budget_id=uuid4(),
            user_id=A_USER,
            category="Food",
            period=JUNE,
            amount=Decimal("50000"),
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        uow = FakeUnitOfWork()
        uow.committed_budgets[existing.id] = existing

        # WHEN
        budget_id = await upsert_budget(
            UpsertBudget(user_id=A_USER, category="Food", period=JUNE, amount=Decimal("75000")),
            uow,
        )

        # THEN — same identity, only one row for the category/month, amount replaced.
        assert budget_id == existing.id
        food_rows = [b for b in uow.committed_budgets.values() if b.category == "Food" and b.period == JUNE]
        assert len(food_rows) == 1
        assert food_rows[0].amount == Decimal("75000")
        assert food_rows[0].created_at == datetime(2026, 1, 1, tzinfo=UTC)  # preserved

    async def test_foreign_owners_target_is_not_replaced(self):
        """
        GIVEN a target owned by another user for the same category/month
        WHEN this user upserts the same category/month
        THEN a separate owned row is inserted — the foreign row is never touched (ADR-130)
        """
        # GIVEN
        foreign = build_budget(
            budget_id=uuid4(),
            user_id=ANOTHER_USER,
            category="Food",
            period=JUNE,
            amount=Decimal("1"),
        )
        uow = FakeUnitOfWork()
        uow.committed_budgets[foreign.id] = foreign

        # WHEN
        budget_id = await upsert_budget(
            UpsertBudget(user_id=A_USER, category="Food", period=JUNE, amount=Decimal("9")),
            uow,
        )

        # THEN
        assert budget_id != foreign.id
        assert uow.committed_budgets[foreign.id].amount == Decimal("1")  # untouched


class TestClearBudgetHandler:
    """The clear handler deletes a target and is idempotent."""

    async def test_clears_existing_target(self):
        """
        GIVEN an existing target
        WHEN the clear handler runs
        THEN the target is removed and the handler reports the removal
        """
        # GIVEN
        existing = build_budget(budget_id=uuid4(), user_id=A_USER, category="Food", period=JUNE, amount=Decimal("1"))
        uow = FakeUnitOfWork()
        uow.committed_budgets[existing.id] = existing

        # WHEN
        removed = await clear_budget(ClearBudget(user_id=A_USER, category="Food", period=JUNE), uow)

        # THEN
        assert removed is True
        assert existing.id not in uow.committed_budgets

    async def test_clearing_absent_target_is_a_noop(self):
        """
        GIVEN no target for a category/month
        WHEN the clear handler runs
        THEN it reports no removal but still commits (idempotent, 204 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        removed = await clear_budget(ClearBudget(user_id=A_USER, category="Food", period=JUNE), uow)

        # THEN
        assert removed is False
        assert uow.committed is True


class TestUpsertBudgetIncomeHandler:
    """The upsert-income handler inserts or replaces a single per-month base."""

    async def test_inserts_a_new_income_base(self):
        """
        GIVEN no existing base for a month
        WHEN the upsert-income handler runs
        THEN a new owned base is committed with its amount and floor
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = UpsertBudgetIncome(
            user_id=A_USER, period=JUNE, amount=Decimal("1200000"), floor_amount=Decimal("500000")
        )

        # WHEN
        income_id = await upsert_budget_income(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_budget_income[income_id]
        assert stored.user_id == A_USER
        assert stored.amount == Decimal("1200000")
        assert stored.floor_amount == Decimal("500000")

    async def test_replaces_existing_base_without_duplicating(self):
        """
        GIVEN an existing base for a month
        WHEN the upsert-income handler runs again with a new amount
        THEN the amount is replaced in place, identity and created_at preserved
        """
        # GIVEN
        existing = build_budget_income(
            income_id=uuid4(),
            user_id=A_USER,
            period=JUNE,
            amount=Decimal("1000000"),
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        uow = FakeUnitOfWork()
        uow.committed_budget_income[existing.id] = existing

        # WHEN
        income_id = await upsert_budget_income(
            UpsertBudgetIncome(user_id=A_USER, period=JUNE, amount=Decimal("1500000")), uow
        )

        # THEN
        assert income_id == existing.id
        rows = [i for i in uow.committed_budget_income.values() if i.period == JUNE]
        assert len(rows) == 1
        assert rows[0].amount == Decimal("1500000")
        assert rows[0].created_at == datetime(2026, 1, 1, tzinfo=UTC)


class TestApplySavingProfileHandler:
    """Apply-profile writes saving rows and reports the floor guard (ADR-138)."""

    async def test_requires_an_income_base(self):
        """
        GIVEN no income base for the month
        WHEN a profile is applied
        THEN MissingIncomeBaseError is raised (set income first)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(MissingIncomeBaseError):
            await apply_saving_profile(ApplySavingProfile(user_id=A_USER, period=JUNE, profile="balanced"), uow)

    async def test_writes_saving_rows_for_each_bucket(self):
        """
        GIVEN an income base
        WHEN the Balanced profile is applied
        THEN one saving row is written per bucket, scoped to the owner
        """
        # GIVEN
        uow = FakeUnitOfWork()
        base = build_budget_income(income_id=uuid4(), user_id=A_USER, period=JUNE, amount=Decimal("1000000"))
        uow.committed_budget_income[base.id] = base

        # WHEN
        result = await apply_saving_profile(ApplySavingProfile(user_id=A_USER, period=JUNE, profile="balanced"), uow)

        # THEN — seven saving rows (six profile buckets + maintenance reserve).
        saving_rows = [b for b in uow.committed_budgets.values() if b.kind is BudgetKind.SAVING]
        assert len(saving_rows) == 7
        emergency = next(b for b in saving_rows if b.category == "EmergencyFund")
        assert emergency.amount == Decimal("70000.00")  # Balanced 7%
        assert result.floor_breached is False

    async def test_reapply_overwrites_rather_than_duplicates(self):
        """
        GIVEN a Balanced profile already applied
        WHEN the Aggressive profile is applied for the same month
        THEN the saving rows are overwritten in place (still seven), not duplicated
        """
        # GIVEN
        uow = FakeUnitOfWork()
        base = build_budget_income(income_id=uuid4(), user_id=A_USER, period=JUNE, amount=Decimal("1000000"))
        uow.committed_budget_income[base.id] = base
        await apply_saving_profile(ApplySavingProfile(user_id=A_USER, period=JUNE, profile="balanced"), uow)

        # WHEN
        await apply_saving_profile(ApplySavingProfile(user_id=A_USER, period=JUNE, profile="aggressive"), uow)

        # THEN
        saving_rows = [b for b in uow.committed_budgets.values() if b.kind is BudgetKind.SAVING]
        assert len(saving_rows) == 7
        emergency = next(b for b in saving_rows if b.category == "EmergencyFund")
        assert emergency.amount == Decimal("80000.00")  # Aggressive 8%

    async def test_floor_breach_is_flagged_but_rows_still_written(self):
        """
        GIVEN an income base whose floor leaves little room
        WHEN an Aggressive profile is applied that would underfund the floor
        THEN the rows are still written and floor_breached is reported with the gap
        """
        # GIVEN — income 1000, floor 900, Aggressive saves 40% (400) -> residual 600 < 900.
        uow = FakeUnitOfWork()
        base = build_budget_income(
            income_id=uuid4(), user_id=A_USER, period=JUNE, amount=Decimal("1000"), floor_amount=Decimal("900")
        )
        uow.committed_budget_income[base.id] = base

        # WHEN
        result = await apply_saving_profile(ApplySavingProfile(user_id=A_USER, period=JUNE, profile="aggressive"), uow)

        # THEN
        assert result.floor_breached is True
        assert result.gap == Decimal("300.00")
        assert any(b.kind is BudgetKind.SAVING for b in uow.committed_budgets.values())


class TestRepriceMonthHandler:
    """Reprice produces new-month spend rows from the source month's caps (ADR-137)."""

    async def test_reprices_spend_rows_into_target_month(self):
        """
        GIVEN spend caps in June
        WHEN the month is repriced into July at 2% inflation
        THEN July gets a repriced spend row per source cap and the count is returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        for category, amount in (("Food", Decimal("100000")), ("Transport", Decimal("50000"))):
            row = build_budget(budget_id=uuid4(), user_id=A_USER, category=category, period=JUNE, amount=amount)
            uow.committed_budgets[row.id] = row

        # WHEN
        count = await reprice_month(
            RepriceMonth(user_id=A_USER, from_period=JUNE, to_period=JULY, monthly_inflation=Decimal("2")), uow
        )

        # THEN
        assert count == 2
        july = [b for b in uow.committed_budgets.values() if b.period == JULY and b.kind is BudgetKind.SPEND]
        food = next(b for b in july if b.category == "Food")
        assert food.amount == Decimal("102000.00")

    async def test_applies_per_category_step_up(self):
        """
        GIVEN a Housing cap and a Housing step-up (a rent index jump)
        WHEN the month is repriced
        THEN the step-up is added after inflation
        """
        # GIVEN
        row = build_budget(budget_id=uuid4(), user_id=A_USER, category="Housing", period=JUNE, amount=Decimal("100000"))
        uow = FakeUnitOfWork()
        uow.committed_budgets[row.id] = row

        # WHEN — 100000 * 1.02 = 102000 + 20000 step-up.
        await reprice_month(
            RepriceMonth(
                user_id=A_USER,
                from_period=JUNE,
                to_period=JULY,
                monthly_inflation=Decimal("2"),
                step_ups={"Housing": Decimal("20000")},
            ),
            uow,
        )

        # THEN
        housing = next(b for b in uow.committed_budgets.values() if b.period == JULY and b.category == "Housing")
        assert housing.amount == Decimal("122000.00")

    async def test_reprice_replaces_existing_target_month_row(self):
        """
        GIVEN a June cap and a stale July cap for the same category
        WHEN June is repriced into July
        THEN July's row is replaced in place (not duplicated) with the repriced amount
        """
        # GIVEN
        june = build_budget(budget_id=uuid4(), user_id=A_USER, category="Food", period=JUNE, amount=Decimal("100000"))
        stale_july = build_budget(budget_id=uuid4(), user_id=A_USER, category="Food", period=JULY, amount=Decimal("1"))
        uow = FakeUnitOfWork()
        uow.committed_budgets[june.id] = june
        uow.committed_budgets[stale_july.id] = stale_july

        # WHEN
        await reprice_month(
            RepriceMonth(user_id=A_USER, from_period=JUNE, to_period=JULY, monthly_inflation=Decimal("2")), uow
        )

        # THEN — exactly one July Food row, carrying the repriced amount.
        july_food = [b for b in uow.committed_budgets.values() if b.period == JULY and b.category == "Food"]
        assert len(july_food) == 1
        assert july_food[0].id == stale_july.id
        assert july_food[0].amount == Decimal("102000.00")

    async def test_does_not_reprice_saving_rows(self):
        """
        GIVEN a June saving row alongside a spend cap
        WHEN the month is repriced
        THEN only the spend cap is carried into July (saving rows re-derive from base)
        """
        # GIVEN
        spend = build_budget(budget_id=uuid4(), user_id=A_USER, category="Food", period=JUNE, amount=Decimal("100000"))
        saving = build_budget(
            budget_id=uuid4(),
            user_id=A_USER,
            category="EmergencyFund",
            period=JUNE,
            amount=Decimal("50000"),
            kind=BudgetKind.SAVING,
        )
        uow = FakeUnitOfWork()
        uow.committed_budgets[spend.id] = spend
        uow.committed_budgets[saving.id] = saving

        # WHEN
        count = await reprice_month(
            RepriceMonth(user_id=A_USER, from_period=JUNE, to_period=JULY, monthly_inflation=Decimal("2")), uow
        )

        # THEN — only the one spend cap repriced; no July saving row.
        assert count == 1
        july = [b for b in uow.committed_budgets.values() if b.period == JULY]
        assert all(b.kind is BudgetKind.SPEND for b in july)
