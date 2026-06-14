"""Unit tests for the transaction application handlers (ADR-028).

The handlers are driven through the in-memory :class:`FakeUnitOfWork` so they run
with no database. They verify that the handler injects identity and timestamps
(ADR-026), builds the aggregate through the domain so invariants run (ADR-031),
applies patches while preserving ``created_at``, and raises
``TransactionNotFoundError`` for missing ids.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.domain.models.exceptions import TransactionNotFoundError
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.handlers import (
    create_transaction,
    delete_transaction,
    update_transaction,
)
from tests.fakes.persistence import FakeUnitOfWork

A_DATE = date(2026, 6, 12)


def _seed(uow: FakeUnitOfWork, **overrides: object) -> UUID:
    """Place a committed aggregate directly in the unit of work's store."""
    defaults: dict[str, object] = {
        "occurred_on": A_DATE,
        "name": "Apartment rent",
        "kind": Kind.EXPENSE,
        "amount": Decimal("1000"),
        "transaction_id": uuid4(),
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    defaults.update(overrides)
    transaction = build_transaction(**defaults)  # type: ignore[arg-type]
    uow.committed_aggregates[transaction.id] = transaction
    return transaction.id


class TestCreateHandler:
    """The create handler persists a new aggregate and returns its identity."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command
        WHEN the create handler runs
        THEN the aggregate is committed and its identity returned
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateTransaction(occurred_on=A_DATE, name="Coto", kind=Kind.EXPENSE, amount=Decimal("250"))

        # WHEN
        transaction_id = await create_transaction(command, uow)

        # THEN
        assert uow.committed is True
        assert transaction_id in uow.committed_aggregates

    async def test_injects_identity_and_timestamps(self):
        """
        GIVEN a create command (which never carries identity or timestamps)
        WHEN the create handler runs
        THEN the handler injects a UUID and created_at == updated_at
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateTransaction(occurred_on=A_DATE, name="Coto", kind=Kind.EXPENSE, amount=Decimal("250"))

        # WHEN
        transaction_id = await create_transaction(command, uow)

        # THEN
        stored = uow.committed_aggregates[transaction_id]
        assert isinstance(stored.id, UUID)
        assert stored.created_at == stored.updated_at

    async def test_runs_domain_invariants(self):
        """
        GIVEN a create command for an expense flagged to count toward monotributo
        WHEN the create handler runs
        THEN the domain forces the counting flag False
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateTransaction(
            occurred_on=A_DATE,
            name="Coto",
            kind=Kind.EXPENSE,
            amount=Decimal("250"),
            counts_toward_monotributo=True,
        )

        # WHEN
        transaction_id = await create_transaction(command, uow)

        # THEN
        assert uow.committed_aggregates[transaction_id].counts_toward_monotributo is False

    async def test_accepts_usd_without_rate(self):
        """
        GIVEN a USD create command with no FX rate
        WHEN the create handler runs
        THEN the aggregate is persisted as incomplete (no raise)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateTransaction(
            occurred_on=A_DATE,
            name="MacBook",
            kind=Kind.EXPENSE,
            amount=Decimal("1000000"),
            currency=Currency.USD,
            usd_amount=Decimal("1000"),
        )

        # WHEN
        transaction_id = await create_transaction(command, uow)

        # THEN
        assert uow.committed_aggregates[transaction_id].has_complete_fx is False


class TestUpdateHandler:
    """The update handler patches an existing aggregate and re-runs invariants."""

    async def test_applies_patch_and_preserves_created_at(self):
        """
        GIVEN an existing aggregate and a patch changing the name and amount
        WHEN the update handler runs
        THEN the patch is applied, created_at preserved, and updated_at bumped
        """
        # GIVEN
        uow = FakeUnitOfWork()
        original_created = datetime(2026, 1, 1, tzinfo=UTC)
        transaction_id = _seed(uow, created_at=original_created, updated_at=original_created)
        command = UpdateTransaction(id=transaction_id, name="Updated rent", amount=Decimal("2000"))

        # WHEN
        await update_transaction(command, uow)

        # THEN
        updated = uow.committed_aggregates[transaction_id]
        assert updated.name == "Updated rent"
        assert updated.amount == Decimal("2000")
        assert updated.created_at == original_created
        assert updated.updated_at > original_created

    async def test_omitted_fields_are_left_unchanged(self):
        """
        GIVEN an existing aggregate and a patch touching only the amount
        WHEN the update handler runs
        THEN the unspecified fields keep their previous values
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transaction_id = _seed(uow, name="Original", amount=Decimal("1000"))
        command = UpdateTransaction(id=transaction_id, amount=Decimal("1500"))

        # WHEN
        await update_transaction(command, uow)

        # THEN
        updated = uow.committed_aggregates[transaction_id]
        assert updated.name == "Original"
        assert updated.amount == Decimal("1500")

    async def test_re_runs_invariants(self):
        """
        GIVEN an income aggregate counting toward monotributo
        WHEN a patch changes its kind to expense
        THEN the re-run invariants force the counting flag False
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transaction_id = _seed(uow, kind=Kind.INCOME, counts_toward_monotributo=True)
        command = UpdateTransaction(id=transaction_id, kind=Kind.EXPENSE)

        # WHEN
        await update_transaction(command, uow)

        # THEN
        assert uow.committed_aggregates[transaction_id].counts_toward_monotributo is False

    async def test_missing_id_raises_not_found(self):
        """
        GIVEN no aggregate for an identity
        WHEN the update handler runs against it
        THEN a TransactionNotFoundError is raised
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = UpdateTransaction(id=uuid4(), name="ghost")

        # WHEN / THEN
        with pytest.raises(TransactionNotFoundError):
            await update_transaction(command, uow)


class TestDeleteHandler:
    """The delete handler hard-deletes an aggregate by identity (ADR-030)."""

    async def test_deletes_existing_aggregate(self):
        """
        GIVEN an existing aggregate
        WHEN the delete handler runs against its identity
        THEN the aggregate is removed and the unit of work commits
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transaction_id = _seed(uow)

        # WHEN
        await delete_transaction(DeleteTransaction(id=transaction_id), uow)

        # THEN
        assert transaction_id not in uow.committed_aggregates
        assert uow.committed is True

    async def test_missing_id_raises_not_found(self):
        """
        GIVEN no aggregate for an identity
        WHEN the delete handler runs against it
        THEN a TransactionNotFoundError is raised
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(TransactionNotFoundError):
            await delete_transaction(DeleteTransaction(id=uuid4()), uow)
