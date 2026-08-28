"""Unit tests for the SQLAlchemy receivables repository (ADR-204, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration migration test).
They cover the ``persist_*`` insert-fallback branches and the person mapper's owner-less
guard, which the happy-path handler flows do not reach.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from margen_api.adapters.models.receivable import PersonRecord, ReceivableItemRecord
from margen_api.adapters.receivable_queries import SqlAlchemyReceivableRepository, _person_record
from margen_api.domain.models.receivable import build_person, build_receivable_item

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous add."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


def _person():
    """Build a minimal valid person aggregate."""
    return build_person(person_id=uuid4(), name="Juan", user_id=A_USER, created_at=A_TIME)


def _item(person_id):
    """Build a minimal valid receivable item aggregate."""
    return build_receivable_item(
        item_id=uuid4(),
        person_id=person_id,
        occurred_on=date(2026, 8, 1),
        amount=Decimal("1000"),
        created_at=A_TIME,
    )


class TestPersistPerson:
    """``persist_person`` updates an attached row, or inserts when none is stored."""

    async def test_inserts_when_no_row_exists(self):
        """
        GIVEN no stored row for the person's id
        WHEN persist_person is called
        THEN the person is added as a fresh insert (the change is not lost)
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_person(_person())

        # THEN
        session.add.assert_called_once()

    async def test_updates_attached_row(self):
        """
        GIVEN a stored row for the person's id
        WHEN persist_person renames it
        THEN the attached record's name is updated in place (no new insert)
        """
        # GIVEN
        session = _session()
        record = PersonRecord()
        session.get.return_value = record
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_person(_person())

        # THEN
        session.add.assert_not_called()
        assert record.name == "Juan"


class TestPersistItem:
    """``persist_item`` updates an attached row, or inserts when none is stored."""

    async def test_inserts_when_no_row_exists(self):
        """
        GIVEN no stored row for the item's id
        WHEN persist_item is called
        THEN the item is added as a fresh insert (the change is not lost)
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_item(_item(uuid4()))

        # THEN
        session.add.assert_called_once()

    async def test_updates_attached_row(self):
        """
        GIVEN a stored row for the item's id
        WHEN persist_item is called
        THEN the attached record's mutable fields are updated in place (no new insert)
        """
        # GIVEN
        session = _session()
        record = ReceivableItemRecord()
        session.get.return_value = record
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_item(_item(uuid4()))

        # THEN
        session.add.assert_not_called()
        assert record.amount == Decimal("1000")


class TestPersonMapperOwnershipGuard:
    """The person mapper refuses to persist a person with no owning user_id (ADR-130)."""

    async def test_person_record_without_user_id_raises(self):
        """
        GIVEN a person aggregate carrying no user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (a missing owner is a programming error)
        """
        # GIVEN
        person = build_person(person_id=uuid4(), name="Juan", user_id=None, created_at=A_TIME)

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            _person_record(person)
