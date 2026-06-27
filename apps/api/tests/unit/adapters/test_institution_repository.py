"""Unit tests for the SQLAlchemy institution repository + mapper (ADR-130, ADR-134).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration migration
test). They cover the persist insert-fallback branch and the mapper's owner-less
guard, which the happy-path e2e flow does not reach.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from margen_api.adapters.institution_repository import SqlAlchemyInstitutionRepository
from margen_api.adapters.mappers.institution import to_record
from margen_api.adapters.models.institution import InstitutionRecord
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.value_objects import InstitutionType

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


def _aggregate(**overrides: object):
    """Build a minimal valid institution aggregate for repository/mapper calls."""
    defaults: dict[str, object] = {
        "institution_id": uuid4(),
        "name": "Galicia",
        "type": InstitutionType.BANK,
        "user_id": A_USER,
        "created_at": A_TIME,
        "updated_at": A_TIME,
    }
    defaults.update(overrides)
    return build_institution(**defaults)  # type: ignore[arg-type]


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
        repo = SqlAlchemyInstitutionRepository(session)

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
        institution = _aggregate(name="Galicia Bank")
        session.get.return_value = InstitutionRecord()
        repo = SqlAlchemyInstitutionRepository(session)

        # WHEN
        await repo.persist(institution)

        # THEN
        session.add.assert_not_called()
        assert session.get.return_value.name == "Galicia Bank"


class TestMapperOwnershipGuard:
    """The mapper refuses to persist an institution with no owning user_id (ADR-130)."""

    async def test_to_record_without_user_id_raises(self):
        """
        GIVEN an institution aggregate carrying no user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (a missing owner is a programming error)
        """
        # GIVEN
        institution = _aggregate(user_id=None)

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            to_record(institution)
