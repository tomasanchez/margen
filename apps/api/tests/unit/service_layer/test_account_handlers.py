"""Unit tests for the account application handlers (ADR-122, ADR-130).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
They verify the create handler injects identity/timestamps and commits (ADR-026),
the update handler patches while preserving ``created_at`` and ownership and raises
``AccountNotFoundError`` for missing/cross-tenant ids (ADR-111).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.models.account import build_account
from margen_api.domain.models.exceptions import AccountNotFoundError
from margen_api.domain.models.value_objects import AccountType, Currency
from margen_api.service_layer.account_handlers import create_account, update_account
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed(uow: FakeUnitOfWork, **overrides: object) -> UUID:
    """Place a committed account directly in the unit of work's store."""
    defaults: dict[str, object] = {
        "name": "Galicia",
        "type": AccountType.BANK,
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
    """The create handler persists a new account and returns its identity."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command
        WHEN the create handler runs
        THEN the account is committed, owned by the caller, and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateAccount(
            user_id=A_USER,
            name="Cash ARS",
            type=AccountType.CASH,
            currency=Currency.ARS,
            opening_balance=Decimal("25000"),
        )

        # WHEN
        account_id = await create_account(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_accounts[account_id]
        assert stored.user_id == A_USER
        assert stored.type is AccountType.CASH
        assert stored.opening_balance == Decimal("25000")


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
        account_id = _seed(uow, name="Galicia", opening_balance=Decimal("0"))

        # WHEN
        await update_account(
            UpdateAccount(id=account_id, user_id=A_USER, name="Galicia Pesos", opening_balance=Decimal("123.45")),
            uow,
        )

        # THEN
        updated = uow.committed_accounts[account_id]
        assert updated.name == "Galicia Pesos"
        assert updated.opening_balance == Decimal("123.45")
        assert updated.type is AccountType.BANK  # left unchanged
        assert updated.created_at == datetime(2026, 1, 1, tzinfo=UTC)
        assert updated.user_id == A_USER

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
            await update_account(UpdateAccount(id=uuid4(), user_id=A_USER, name="X"), uow)

    async def test_cross_tenant_update_is_not_found(self):
        """
        GIVEN an account owned by user A
        WHEN user B attempts to update it
        THEN AccountNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        account_id = _seed(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await update_account(UpdateAccount(id=account_id, user_id=ANOTHER_USER, name="Hijack"), uow)
