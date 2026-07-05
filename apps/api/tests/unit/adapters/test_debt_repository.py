"""Unit tests for the SQLAlchemy debt repository + mapper (ADR-187, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration migration test).
They cover the persist insert-fallback branch and the mapper's owner-less guard, which
the happy-path e2e flow does not reach.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from margen_api.adapters.debt_repository import SqlAlchemyDebtRepository
from margen_api.adapters.mappers.debt import to_record
from margen_api.adapters.models.debt import DebtRecord
from margen_api.domain.models.debt import build_debt
from margen_api.domain.models.value_objects import Currency

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


def _aggregate(**overrides: object):
    """Build a minimal valid debt aggregate for repository/mapper calls."""
    defaults: dict[str, object] = {
        "debt_id": uuid4(),
        "name": "Banco Nación loan",
        "currency": Currency.ARS,
        "current_balance": Decimal("100000"),
        "user_id": A_USER,
        "created_at": A_TIME,
        "updated_at": A_TIME,
    }
    defaults.update(overrides)
    return build_debt(**defaults)  # type: ignore[arg-type]


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
        repo = SqlAlchemyDebtRepository(session)

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
        debt = _aggregate(current_balance=Decimal("123.45"))
        session.get.return_value = DebtRecord()
        repo = SqlAlchemyDebtRepository(session)

        # WHEN
        await repo.persist(debt)

        # THEN
        session.add.assert_not_called()
        assert session.get.return_value.current_balance == Decimal("123.45")


class TestMapperOwnershipGuard:
    """The mapper refuses to persist a debt with no owning user_id (ADR-130)."""

    async def test_to_record_without_user_id_raises(self):
        """
        GIVEN a debt aggregate carrying no user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (a missing owner is a programming error)
        """
        # GIVEN
        debt = _aggregate(user_id=None)

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            to_record(debt)
