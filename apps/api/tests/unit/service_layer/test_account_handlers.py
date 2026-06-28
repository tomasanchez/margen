"""Unit tests for the account application handlers (ADR-122, ADR-130, ADR-134).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
They verify the create handler checks institution ownership, injects
identity/timestamps and commits (ADR-026, ADR-134), and the update handler patches
while preserving ``created_at`` and ownership and raises ``AccountNotFoundError``
for missing/cross-tenant ids and ``InstitutionNotFoundError`` for foreign
institution links (ADR-111, ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.models.account import build_account
from margen_api.domain.models.exceptions import AccountNotFoundError, InstitutionNotFoundError
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.value_objects import Currency, InstitutionType
from margen_api.service_layer.account_handlers import create_account, update_account
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed_institution(
    uow: FakeUnitOfWork, *, user_id: str = A_USER, type_: InstitutionType = InstitutionType.BANK
) -> UUID:
    """Place a committed institution in the unit of work's store and return its id."""
    institution = build_institution(
        institution_id=uuid4(),
        name="Galicia",
        type=type_,
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_institutions[institution.id] = institution
    return institution.id


def _seed_account(uow: FakeUnitOfWork, institution_id: UUID, **overrides: object) -> UUID:
    """Place a committed account directly in the unit of work's store."""
    defaults: dict[str, object] = {
        "institution_id": institution_id,
        "currency": Currency.ARS,
        "opening_balance": Decimal("0"),
        "account_id": uuid4(),
        "user_id": A_USER,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    defaults.update(overrides)
    account = build_account(**defaults)  # type: ignore[arg-type]
    uow.committed_accounts[account.id] = account
    return account.id


class TestCreateAccountHandler:
    """The create handler persists a new account under an owned institution."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command referencing an owned institution
        WHEN the create handler runs
        THEN the account is committed, owned by the caller, and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed_institution(uow)
        command = CreateAccount(
            user_id=A_USER,
            institution_id=institution_id,
            currency=Currency.ARS,
            opening_balance=Decimal("25000"),
        )

        # WHEN
        account_id = await create_account(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_accounts[account_id]
        assert stored.user_id == A_USER
        assert stored.institution_id == institution_id
        assert stored.opening_balance == Decimal("25000")

    async def test_unknown_institution_raises_not_found(self):
        """
        GIVEN no institution with the referenced id
        WHEN a create command links it
        THEN InstitutionNotFoundError is raised and nothing is committed (ADR-130, ADR-134)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(InstitutionNotFoundError):
            await create_account(CreateAccount(user_id=A_USER, institution_id=uuid4()), uow)
        assert uow.committed_accounts == {}

    async def test_foreign_institution_is_not_found(self):
        """
        GIVEN an institution owned by another user
        WHEN the caller creates an account under it
        THEN InstitutionNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        foreign = _seed_institution(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(InstitutionNotFoundError):
            await create_account(CreateAccount(user_id=A_USER, institution_id=foreign), uow)


class TestUpdateAccountHandler:
    """The update handler patches an owned account and re-runs invariants."""

    async def test_patches_present_fields_and_preserves_created_at(self):
        """
        GIVEN an existing owned account
        WHEN the update handler applies a partial patch
        THEN only the present fields change and created_at/ownership are preserved
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed_institution(uow)
        account_id = _seed_account(uow, institution_id, opening_balance=Decimal("0"))

        # WHEN
        await update_account(
            UpdateAccount(id=account_id, user_id=A_USER, opening_balance=Decimal("123.45")),
            uow,
        )

        # THEN
        updated = uow.committed_accounts[account_id]
        assert updated.opening_balance == Decimal("123.45")
        assert updated.institution_id == institution_id  # left unchanged
        assert updated.created_at == datetime(2026, 1, 1, tzinfo=UTC)
        assert updated.user_id == A_USER

    async def test_reassigning_to_foreign_institution_is_not_found(self):
        """
        GIVEN an owned account and an institution owned by another user
        WHEN the caller patches the account to link the foreign institution
        THEN InstitutionNotFoundError is raised (ADR-130, ADR-134)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed_institution(uow)
        account_id = _seed_account(uow, institution_id)
        foreign = _seed_institution(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(InstitutionNotFoundError):
            await update_account(
                UpdateAccount(id=account_id, user_id=A_USER, institution_id=foreign),
                uow,
            )

    async def test_missing_account_raises_not_found(self):
        """
        GIVEN no account with the requested id
        WHEN the update handler runs
        THEN AccountNotFoundError is raised (mapped to 404 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await update_account(UpdateAccount(id=uuid4(), user_id=A_USER, opening_balance=Decimal("1")), uow)

    async def test_cross_tenant_update_is_not_found(self):
        """
        GIVEN an account owned by user A
        WHEN user B attempts to update it
        THEN AccountNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        institution_id = _seed_institution(uow)
        account_id = _seed_account(uow, institution_id, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await update_account(UpdateAccount(id=account_id, user_id=ANOTHER_USER, opening_balance=Decimal("1")), uow)
