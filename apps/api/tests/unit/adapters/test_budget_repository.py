"""Unit tests for the SQLAlchemy budget repository (ADR-125, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration test). They
cover the ``persist`` insert-fallback and update-in-place branches and the ``delete``
miss branch, which the happy-path e2e upsert flow does not always reach.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from margen_api.adapters.budget_repository import SqlAlchemyBudgetRepository
from margen_api.adapters.models.budget import BudgetRecord
from margen_api.domain.models.budget import build_budget

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
JUNE = date(2026, 6, 1)


def _aggregate(**overrides: object):
    """Build a minimal valid budget aggregate for repository calls."""
    defaults: dict[str, object] = {
        "budget_id": uuid4(),
        "user_id": A_USER,
        "category": "Food",
        "period": JUNE,
        "amount": Decimal("50000"),
        "created_at": A_TIME,
        "updated_at": A_TIME,
    }
    defaults.update(overrides)
    return build_budget(**defaults)  # type: ignore[arg-type]


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
        repo = SqlAlchemyBudgetRepository(session)

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
        budget = _aggregate(amount=Decimal("99000"))
        session.get.return_value = BudgetRecord()
        repo = SqlAlchemyBudgetRepository(session)

        # WHEN
        await repo.persist(budget)

        # THEN
        session.add.assert_not_called()
        assert session.get.return_value.amount == Decimal("99000")


class TestDelete:
    """``delete`` reports a miss when no owned row matches (ADR-130)."""

    async def test_delete_reports_miss_when_absent(self):
        """
        GIVEN no owned row for the category/month
        WHEN delete is called
        THEN it returns False and never calls session.delete (idempotent clear)
        """
        # GIVEN
        session = _session()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        session.execute.return_value = result
        repo = SqlAlchemyBudgetRepository(session)

        # WHEN
        removed = await repo.delete("Food", JUNE, A_USER)

        # THEN
        assert removed is False
        session.delete.assert_not_called()
