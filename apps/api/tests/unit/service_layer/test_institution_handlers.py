"""Unit tests for the institution application handlers (ADR-130, ADR-134).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
They verify the create handler injects identity/timestamps and commits (ADR-026),
and the update handler patches while preserving ``created_at`` and ownership and
raises ``InstitutionNotFoundError`` for missing/cross-tenant ids (ADR-111).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.institution import CreateInstitution, UpdateInstitution
from margen_api.domain.models.exceptions import InstitutionNotFoundError
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.value_objects import InstitutionType
from margen_api.service_layer.institution_handlers import create_institution, update_institution
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed(uow: FakeUnitOfWork, **overrides: object) -> UUID:
    """Place a committed institution directly in the unit of work's store."""
    defaults: dict[str, object] = {
        "name": "Galicia",
        "type": InstitutionType.BANK,
        "institution_id": uuid4(),
        "user_id": A_USER,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    defaults.update(overrides)
    institution = build_institution(**defaults)  # type: ignore[arg-type]
    uow.committed_institutions[institution.id] = institution
    return institution.id


class TestCreateInstitutionHandler:
    """The create handler persists a new institution and returns its identity."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command
        WHEN the create handler runs
        THEN the institution is committed, owned by the caller, and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateInstitution(user_id=A_USER, name="Deel", type=InstitutionType.WALLET)

        # WHEN
        institution_id = await create_institution(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_institutions[institution_id]
        assert stored.user_id == A_USER
        assert stored.name == "Deel"
        assert stored.type is InstitutionType.WALLET
        # A non-card institution carries no card identity (ADR-190).
        assert stored.brand is None
        assert stored.last4 is None

    async def test_persists_card_identity(self):
        """
        GIVEN a create command for a CARD with brand + last4 (ADR-190)
        WHEN the create handler runs
        THEN the card identity is persisted on the institution
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateInstitution(
            user_id=A_USER,
            name="Galicia",
            type=InstitutionType.CARD,
            brand="VISA",
            last4="5771",
        )

        # WHEN
        institution_id = await create_institution(command, uow)

        # THEN
        stored = uow.committed_institutions[institution_id]
        assert stored.type is InstitutionType.CARD
        assert stored.brand == "VISA"
        assert stored.last4 == "5771"


class TestUpdateInstitutionHandler:
    """The update handler patches an owned institution and re-runs invariants."""

    async def test_patches_present_fields_and_preserves_created_at(self):
        """
        GIVEN an existing owned institution
        WHEN the update handler applies a partial patch
        THEN only the present fields change and created_at/ownership are preserved
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed(uow, name="Galicia", type=InstitutionType.BANK)

        # WHEN — only the name is patched; type is omitted (left unchanged).
        await update_institution(
            UpdateInstitution(id=institution_id, user_id=A_USER, name="Galicia Bank"),
            uow,
        )

        # THEN
        updated = uow.committed_institutions[institution_id]
        assert updated.name == "Galicia Bank"
        assert updated.type is InstitutionType.BANK  # left unchanged
        assert updated.created_at == datetime(2026, 1, 1, tzinfo=UTC)
        assert updated.user_id == A_USER

    async def test_missing_institution_raises_not_found(self):
        """
        GIVEN no institution with the requested id
        WHEN the update handler runs
        THEN InstitutionNotFoundError is raised (mapped to 404 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(InstitutionNotFoundError):
            await update_institution(UpdateInstitution(id=uuid4(), user_id=A_USER, name="X"), uow)

    async def test_cross_tenant_update_is_not_found(self):
        """
        GIVEN an institution owned by user A
        WHEN user B attempts to update it
        THEN InstitutionNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(InstitutionNotFoundError):
            await update_institution(UpdateInstitution(id=institution_id, user_id=ANOTHER_USER, name="Hijack"), uow)
