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

from margen_api.domain.commands.statement import (
    ImportStatement,
    StatementDocumentPayload,
    StatementLineInput,
)
from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.domain.models.account import build_account
from margen_api.domain.models.exceptions import AccountNotFoundError, TransactionNotFoundError
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.handlers import (
    create_transaction,
    delete_transaction,
    import_statement,
    update_transaction,
)
from tests.fakes.persistence import FakeUnitOfWork

A_DATE = date(2026, 6, 12)
A_USER = "00000000-0000-4000-8000-000000000001"


def _seed(uow: FakeUnitOfWork, **overrides: object) -> UUID:
    """Place a committed aggregate directly in the unit of work's store."""
    defaults: dict[str, object] = {
        "occurred_on": A_DATE,
        "name": "Apartment rent",
        "kind": Kind.EXPENSE,
        "amount": Decimal("1000"),
        "transaction_id": uuid4(),
        "user_id": A_USER,
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
        command = CreateTransaction(
            occurred_on=A_DATE, name="Coto", kind=Kind.EXPENSE, amount=Decimal("250"), user_id=A_USER
        )

        # WHEN
        transaction_id = await create_transaction(command, uow)

        # THEN
        assert uow.committed is True
        assert transaction_id in uow.committed_aggregates
        # The handler stamps the command's owner onto the inserted aggregate (ADR-108).
        assert uow.committed_aggregates[transaction_id].user_id == A_USER

    async def test_injects_identity_and_timestamps(self):
        """
        GIVEN a create command (which never carries identity or timestamps)
        WHEN the create handler runs
        THEN the handler injects a UUID and created_at == updated_at
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = CreateTransaction(
            occurred_on=A_DATE, name="Coto", kind=Kind.EXPENSE, amount=Decimal("250"), user_id=A_USER
        )

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
            user_id=A_USER,
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
            user_id=A_USER,
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
        command = UpdateTransaction(id=transaction_id, name="Updated rent", amount=Decimal("2000"), user_id=A_USER)

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
        command = UpdateTransaction(id=transaction_id, amount=Decimal("1500"), user_id=A_USER)

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
        command = UpdateTransaction(id=transaction_id, kind=Kind.EXPENSE, user_id=A_USER)

        # WHEN
        await update_transaction(command, uow)

        # THEN
        assert uow.committed_aggregates[transaction_id].counts_toward_monotributo is False

    async def test_downgrading_cadence_from_installment_clears_plan_fields(self):
        """
        GIVEN an installment transaction with a total/index plan
        WHEN a patch switches its cadence to monthly (the frontend sends null plan fields)
        THEN both installment plan fields are cleared, not left stale (ADR-174)
        """
        # GIVEN — an installment plan (cuota 2/4).
        uow = FakeUnitOfWork()
        transaction_id = _seed(
            uow,
            recurring_cadence=RecurringCadence.INSTALLMENT,
            installments_total=4,
            installments_index=2,
        )
        # The edit form sends nulls to clear; only the cadence carries a new value.
        command = UpdateTransaction(id=transaction_id, recurring_cadence=RecurringCadence.MONTHLY, user_id=A_USER)

        # WHEN
        await update_transaction(command, uow)

        # THEN — the stale plan fields are dropped alongside the cadence change.
        updated = uow.committed_aggregates[transaction_id]
        assert updated.recurring_cadence is RecurringCadence.MONTHLY
        assert updated.installments_total is None
        assert updated.installments_index is None

    async def test_patch_keeping_installment_cadence_preserves_plan_fields(self):
        """
        GIVEN an installment transaction with a total/index plan
        WHEN a patch touches an unrelated field while the cadence stays installment
        THEN the installment plan fields are preserved (only a downgrade clears them, ADR-174)
        """
        # GIVEN — an installment plan (cuota 2/4).
        uow = FakeUnitOfWork()
        transaction_id = _seed(
            uow,
            recurring_cadence=RecurringCadence.INSTALLMENT,
            installments_total=4,
            installments_index=2,
        )
        command = UpdateTransaction(id=transaction_id, name="Renamed plan", user_id=A_USER)

        # WHEN
        await update_transaction(command, uow)

        # THEN — cadence is still installment, so the plan fields survive.
        updated = uow.committed_aggregates[transaction_id]
        assert updated.recurring_cadence is RecurringCadence.INSTALLMENT
        assert updated.installments_total == 4
        assert updated.installments_index == 2

    async def test_missing_id_raises_not_found(self):
        """
        GIVEN no aggregate for an identity
        WHEN the update handler runs against it
        THEN a TransactionNotFoundError is raised
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = UpdateTransaction(id=uuid4(), name="ghost", user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(TransactionNotFoundError):
            await update_transaction(command, uow)

    async def test_cross_tenant_id_raises_not_found(self):
        """
        GIVEN an aggregate owned by another user
        WHEN the update handler runs for a different owner
        THEN it raises TransactionNotFoundError and leaves the row untouched (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transaction_id = _seed(uow, name="Theirs", user_id="ffffffff-0000-4000-8000-000000000002")
        command = UpdateTransaction(id=transaction_id, name="Hijacked", user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(TransactionNotFoundError):
            await update_transaction(command, uow)
        assert uow.committed_aggregates[transaction_id].name == "Theirs"


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
        await delete_transaction(DeleteTransaction(id=transaction_id, user_id=A_USER), uow)

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
            await delete_transaction(DeleteTransaction(id=uuid4(), user_id=A_USER), uow)

    async def test_cross_tenant_id_raises_not_found(self):
        """
        GIVEN an aggregate owned by another user
        WHEN the delete handler runs for a different owner
        THEN it raises TransactionNotFoundError and the row survives (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transaction_id = _seed(uow, name="Theirs", user_id="ffffffff-0000-4000-8000-000000000002")

        # WHEN / THEN
        with pytest.raises(TransactionNotFoundError):
            await delete_transaction(DeleteTransaction(id=transaction_id, user_id=A_USER), uow)
        assert transaction_id in uow.committed_aggregates


def _seed_account(uow: FakeUnitOfWork, *, user_id: str = A_USER) -> UUID:
    """Place a committed account directly in the unit of work's account store (ADR-130)."""
    account = build_account(institution_id=uuid4(), currency=Currency.ARS, user_id=user_id)
    uow.committed_accounts[account.id] = account
    return account.id


def _document() -> StatementDocumentPayload:
    """Build a minimal statement document payload for an import command."""
    return StatementDocumentPayload(pdf_bytes=b"%PDF-1.4", content_type="application/pdf", byte_size=8)


def _import_line(**overrides: object) -> StatementLineInput:
    """Build a single confirmed import line with sensible defaults."""
    defaults: dict[str, object] = {
        "occurred_on": A_DATE,
        "name": "MERPAGO*PASSLINE",
        "amount": Decimal("3641.66"),
    }
    defaults.update(overrides)
    return StatementLineInput(**defaults)  # type: ignore[arg-type]


class TestImportStatementAccountAttachment:
    """The import handler attaches each line to a same-owner card account (ADR-184, ADR-130)."""

    async def test_line_with_owned_account_id_attaches_the_expense(self):
        """
        GIVEN an import line carrying an accountId the caller owns
        WHEN the import handler runs
        THEN the created expense is attached to that account (ADR-184)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        account_id = _seed_account(uow)
        command = ImportStatement(document=_document(), lines=[_import_line(account_id=account_id)], user_id=A_USER)

        # WHEN
        result = await import_statement(command, uow)

        # THEN
        created_id = result.created_transaction_ids[0]
        assert uow.committed_aggregates[created_id].account_id == account_id
        assert uow.committed is True

    async def test_line_without_account_id_stays_unattached(self):
        """
        GIVEN an import line with no accountId
        WHEN the import handler runs
        THEN the created expense is unattached (today's tolerant behavior, ADR-184)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        command = ImportStatement(document=_document(), lines=[_import_line()], user_id=A_USER)

        # WHEN
        result = await import_statement(command, uow)

        # THEN
        created_id = result.created_transaction_ids[0]
        assert uow.committed_aggregates[created_id].account_id is None

    async def test_line_with_another_users_account_id_raises_not_found(self):
        """
        GIVEN an import line referencing an account owned by another user
        WHEN the import handler runs
        THEN the same-owner rule raises AccountNotFoundError and nothing commits (ADR-184, ADR-130)
        """
        # GIVEN — an account owned by a DIFFERENT user.
        uow = FakeUnitOfWork()
        foreign_account_id = _seed_account(uow, user_id="ffffffff-0000-4000-8000-000000000002")
        command = ImportStatement(
            document=_document(), lines=[_import_line(account_id=foreign_account_id)], user_id=A_USER
        )

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await import_statement(command, uow)
        assert uow.committed is False
