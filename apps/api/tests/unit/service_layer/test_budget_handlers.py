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

from margen_api.domain.commands.budget import ClearBudget, UpsertBudget
from margen_api.domain.models.budget import build_budget
from margen_api.service_layer.budget_handlers import clear_budget, upsert_budget
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"
JUNE = date(2026, 6, 1)


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
