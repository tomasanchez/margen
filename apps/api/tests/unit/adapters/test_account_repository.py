"""Unit tests for the SQLAlchemy account repository + mapper (ADR-122, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration migration
test). They cover the persist insert-fallback branch and the mapper's owner-less
guard, which the happy-path e2e flow does not reach.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from margen_api.adapters.account_repository import SqlAlchemyAccountRepository
from margen_api.adapters.mappers.account import to_record
from margen_api.adapters.models.account import AccountRecord
from margen_api.domain.models.account import build_account
from margen_api.domain.models.value_objects import Currency

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
AN_INSTITUTION = uuid4()


def _aggregate(**overrides: object):
    """Build a minimal valid account aggregate for repository/mapper calls."""
    defaults: dict[str, object] = {
        "account_id": uuid4(),
        "institution_id": AN_INSTITUTION,
        "currency": Currency.ARS,
        "opening_balance": Decimal("0"),
        "user_id": A_USER,
        "created_at": A_TIME,
        "updated_at": A_TIME,
    }
    defaults.update(overrides)
    return build_account(**defaults)  # type: ignore[arg-type]


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
        repo = SqlAlchemyAccountRepository(session)

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
        account = _aggregate(opening_balance=Decimal("123.45"))
        session.get.return_value = AccountRecord()
        repo = SqlAlchemyAccountRepository(session)

        # WHEN
        await repo.persist(account)

        # THEN
        session.add.assert_not_called()
        assert session.get.return_value.opening_balance == Decimal("123.45")


class TestMapperOwnershipGuard:
    """The mapper refuses to persist an account with no owning user_id (ADR-130)."""

    async def test_to_record_without_user_id_raises(self):
        """
        GIVEN an account aggregate carrying no user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (a missing owner is a programming error)
        """
        # GIVEN
        account = _aggregate(user_id=None)

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            to_record(account)
