"""Unit tests for the SQLAlchemy budget-income repository (ADR-139, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier). They cover the ``persist``
insert-fallback and update-in-place branches the happy-path e2e upsert flow does not
always reach.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from margen_api.adapters.budget_income_repository import SqlAlchemyBudgetIncomeRepository
from margen_api.adapters.models.budget_income import BudgetIncomeRecord
from margen_api.domain.models.budget_income import build_budget_income

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
JUNE = date(2026, 6, 1)


def _aggregate(**overrides: object):
    """Build a minimal valid income aggregate for repository calls."""
    defaults: dict[str, object] = {
        "income_id": uuid4(),
        "user_id": A_USER,
        "period": JUNE,
        "amount": Decimal("1000000"),
        "created_at": A_TIME,
        "updated_at": A_TIME,
    }
    defaults.update(overrides)
    return build_budget_income(**defaults)  # type: ignore[arg-type]


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous add."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


class TestPersist:
    """``persist`` updates an attached row, or inserts when none is stored."""

    async def test_persist_inserts_when_no_row_exists(self):
        """
        GIVEN no stored row for the aggregate's id
        WHEN persist is called
        THEN the aggregate is added as a fresh insert (the change is not lost)
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repo = SqlAlchemyBudgetIncomeRepository(session)

        # WHEN
        await repo.persist(_aggregate())

        # THEN
        session.add.assert_called_once()

    async def test_persist_updates_attached_row(self):
        """
        GIVEN a stored row for the aggregate's id
        WHEN persist is called
        THEN the attached record is updated in place (no new insert)
        """
        # GIVEN
        session = _session()
        income = _aggregate(amount=Decimal("1500000"))
        session.get.return_value = BudgetIncomeRecord()
        repo = SqlAlchemyBudgetIncomeRepository(session)

        # WHEN
        await repo.persist(income)

        # THEN
        session.add.assert_not_called()
        assert session.get.return_value.amount == Decimal("1500000")

    async def test_get_by_period_returns_none_when_absent(self):
        """
        GIVEN no stored base for the owner/month
        WHEN get_by_period is called
        THEN it returns None
        """
        # GIVEN
        session = _session()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        session.execute.return_value = result
        repo = SqlAlchemyBudgetIncomeRepository(session)

        # WHEN / THEN
        assert await repo.get_by_period(JUNE, A_USER) is None
