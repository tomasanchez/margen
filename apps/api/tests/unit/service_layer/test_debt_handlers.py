"""Unit tests for the debt application handlers (ADR-187, ADR-130).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database. They
verify the create handler injects identity/timestamps and commits (ADR-026), the update
handler patches while preserving ``created_at`` and ownership and raises
``DebtNotFoundError`` for missing/cross-tenant ids (ADR-111), and the delete handler is an
owner-scoped hard delete (ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.debt import CreateDebt, DeleteDebt, UpdateDebt
from margen_api.domain.models.debt import build_debt
from margen_api.domain.models.exceptions import DebtNotFoundError
from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.debt_handlers import create_debt, delete_debt, update_debt
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed_debt(uow: FakeUnitOfWork, **overrides: object) -> UUID:
    """Place a committed debt directly in the unit of work's store and return its id."""
    defaults: dict[str, object] = {
        "name": "Banco Nación loan",
        "currency": Currency.ARS,
        "current_balance": Decimal("100000"),
        "debt_id": uuid4(),
        "user_id": A_USER,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    defaults.update(overrides)
    debt = build_debt(**defaults)  # type: ignore[arg-type]
    uow.committed_debts[debt.id] = debt
    return debt.id


class TestCreateDebtHandler:
    """The create handler persists a new owned debt (ADR-187, ADR-130)."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command
        WHEN the create handler runs
        THEN the debt is committed, owned by the caller, and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateDebt(
            user_id=A_USER,
            name="Personal loan",
            currency=Currency.USD,
            current_balance=Decimal("2500"),
            monthly_minimum=Decimal("100"),
            rate=Decimal("12.5"),
        )

        # WHEN
        debt_id = await create_debt(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_debts[debt_id]
        assert stored.user_id == A_USER
        assert stored.name == "Personal loan"
        assert stored.currency is Currency.USD
        assert stored.current_balance == Decimal("2500")
        assert stored.monthly_minimum == Decimal("100")
        assert stored.rate == Decimal("12.5")


class TestUpdateDebtHandler:
    """The update handler patches an owned debt and re-runs invariants (ADR-187, ADR-130)."""

    async def test_patches_present_fields_and_preserves_created_at(self):
        """
        GIVEN an existing owned debt
        WHEN the update handler applies a partial patch
        THEN only the present fields change and created_at/ownership are preserved
        """
        # GIVEN
        uow = FakeUnitOfWork()
        debt_id = _seed_debt(uow, current_balance=Decimal("100000"), name="Old name")

        # WHEN
        await update_debt(
            UpdateDebt(id=debt_id, user_id=A_USER, current_balance=Decimal("80000")),
            uow,
        )

        # THEN
        updated = uow.committed_debts[debt_id]
        assert updated.current_balance == Decimal("80000")
        assert updated.name == "Old name"  # left unchanged
        assert updated.created_at == datetime(2026, 1, 1, tzinfo=UTC)
        assert updated.user_id == A_USER

    async def test_missing_debt_raises_not_found(self):
        """
        GIVEN no debt with the requested id
        WHEN the update handler runs
        THEN DebtNotFoundError is raised (mapped to 404 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(DebtNotFoundError):
            await update_debt(UpdateDebt(id=uuid4(), user_id=A_USER, current_balance=Decimal("1")), uow)

    async def test_cross_tenant_update_is_not_found(self):
        """
        GIVEN a debt owned by user A
        WHEN user B attempts to update it
        THEN DebtNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        debt_id = _seed_debt(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(DebtNotFoundError):
            await update_debt(UpdateDebt(id=debt_id, user_id=ANOTHER_USER, current_balance=Decimal("1")), uow)


class TestDeleteDebtHandler:
    """The delete handler is an owner-scoped hard delete (ADR-187, ADR-130)."""

    async def test_deletes_owned_debt(self):
        """
        GIVEN an existing owned debt
        WHEN the delete handler runs
        THEN the debt is removed and the delete is committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        debt_id = _seed_debt(uow, user_id=A_USER)

        # WHEN
        await delete_debt(DeleteDebt(id=debt_id, user_id=A_USER), uow)

        # THEN
        assert debt_id not in uow.committed_debts
        assert uow.committed is True

    async def test_missing_debt_raises_not_found(self):
        """
        GIVEN no debt with the requested id
        WHEN the delete handler runs
        THEN DebtNotFoundError is raised (mapped to 404 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(DebtNotFoundError):
            await delete_debt(DeleteDebt(id=uuid4(), user_id=A_USER), uow)

    async def test_cross_tenant_delete_is_not_found(self):
        """
        GIVEN a debt owned by user A
        WHEN user B attempts to delete it
        THEN DebtNotFoundError is raised and A's debt survives (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        debt_id = _seed_debt(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(DebtNotFoundError):
            await delete_debt(DeleteDebt(id=debt_id, user_id=ANOTHER_USER), uow)
        assert debt_id in uow.committed_debts
