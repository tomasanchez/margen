"""Unit tests for the transfer application handlers (ADR-135, ADR-130).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
They verify the create handler checks ownership of both transfer accounts and every
fee account, builds the transfer through the domain, records each fee as a "Fees"
expense transaction in the fee account's native currency, and commits atomically
(ADR-135). The delete handler is owner-scoped and leaves fee expenses untouched
(ADR-135, ADR-111).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.transfer import CreateTransfer, DeleteTransfer, TransferFeeInput
from margen_api.domain.models.account import build_account
from margen_api.domain.models.exceptions import AccountNotFoundError, TransferNotFoundError
from margen_api.domain.models.transfer import build_transfer
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.transfer_handlers import FEES_CATEGORY, create_transfer, delete_transfer
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"
A_DATE = date(2026, 6, 12)
AN_INSTITUTION = UUID("00000000-0000-4000-8000-0000000000ff")


def _seed_account(uow: FakeUnitOfWork, *, currency: Currency = Currency.ARS, user_id: str = A_USER) -> UUID:
    """Place a committed account directly in the unit of work's store and return its id."""
    account = build_account(
        account_id=uuid4(),
        institution_id=AN_INSTITUTION,
        currency=currency,
        opening_balance=Decimal("0"),
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_accounts[account.id] = account
    return account.id


class TestCreateTransferHandler:
    """The create handler persists a transfer and its fee expenses atomically."""

    async def test_persists_transfer_and_commits(self):
        """
        GIVEN a valid create command between two owned accounts and no fees
        WHEN the create handler runs
        THEN the transfer is committed, owned by the caller, with no fee expenses
        """
        # GIVEN
        uow = FakeUnitOfWork()
        source = _seed_account(uow)
        destination = _seed_account(uow)
        command = CreateTransfer(
            user_id=A_USER,
            from_account_id=source,
            to_account_id=destination,
            amount_out=Decimal("1000"),
            amount_in=Decimal("1000"),
            occurred_on=A_DATE,
        )

        # WHEN
        result = await create_transfer(command, uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_transfers[result.transfer_id]
        assert stored.user_id == A_USER
        assert stored.amount_out == Decimal("1000")
        assert result.fee_transaction_ids == ()
        assert uow.committed_aggregates == {}

    async def test_fees_become_expense_transactions_in_fees_category(self):
        """
        GIVEN a transfer carrying a fee on the USD source account
        WHEN the create handler runs
        THEN a kind=expense transaction in the "Fees" category is created in the
             account's native currency, atomically with the transfer (ADR-135)
        """
        # GIVEN — a USD source (Deel) and an ARS destination (Galicia).
        uow = FakeUnitOfWork()
        source = _seed_account(uow, currency=Currency.USD)
        destination = _seed_account(uow, currency=Currency.ARS)
        command = CreateTransfer(
            user_id=A_USER,
            from_account_id=source,
            to_account_id=destination,
            amount_out=Decimal("1000"),
            amount_in=Decimal("950000"),
            occurred_on=A_DATE,
            fees=(TransferFeeInput(account_id=source, amount=Decimal("11"), label="Deel fee"),),
        )

        # WHEN
        result = await create_transfer(command, uow)

        # THEN — exactly one fee expense, in USD (the source's native currency).
        assert len(result.fee_transaction_ids) == 1
        fee = uow.committed_aggregates[result.fee_transaction_ids[0]]
        assert fee.kind is Kind.EXPENSE
        assert fee.category == FEES_CATEGORY
        assert fee.name == "Deel fee"
        assert fee.amount == Decimal("11")
        assert fee.currency is Currency.USD
        assert fee.account_id == source
        assert fee.user_id == A_USER

    async def test_fee_with_fx_snapshot_materializes_usd_amount(self):
        """
        GIVEN a transfer whose ARS fee carries an FX snapshot (fx_rate + fx_source)
        WHEN the create handler runs
        THEN the fee expense materializes usd_amount = round(amount / rate, 2) and
             persists the snapshot exactly like a normal expense (ADR-148, ADR-149)
        """
        # GIVEN — an ARS fee account with a client-stamped MEP rate.
        uow = FakeUnitOfWork()
        source = _seed_account(uow, currency=Currency.ARS)
        destination = _seed_account(uow, currency=Currency.ARS)
        command = CreateTransfer(
            user_id=A_USER,
            from_account_id=source,
            to_account_id=destination,
            amount_out=Decimal("1000"),
            amount_in=Decimal("1000"),
            occurred_on=A_DATE,
            fees=(
                TransferFeeInput(
                    account_id=source,
                    amount=Decimal("10"),
                    label="Bank fee",
                    fx_rate=Decimal("1000"),
                    fx_source="mep",
                ),
            ),
        )

        # WHEN
        result = await create_transfer(command, uow)

        # THEN
        fee = uow.committed_aggregates[result.fee_transaction_ids[0]]
        assert fee.currency is Currency.ARS
        assert fee.fx_rate == Decimal("1000")
        assert fee.fx_source == "mep"
        assert fee.usd_amount == Decimal("0.01")

    async def test_fee_without_fx_snapshot_stays_null(self):
        """
        GIVEN a transfer whose ARS fee carries NO FX snapshot
        WHEN the create handler runs
        THEN the fee expense is created with a null usd_amount and no crash (tolerant, ADR-031)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        source = _seed_account(uow, currency=Currency.ARS)
        destination = _seed_account(uow, currency=Currency.ARS)
        command = CreateTransfer(
            user_id=A_USER,
            from_account_id=source,
            to_account_id=destination,
            amount_out=Decimal("1000"),
            amount_in=Decimal("1000"),
            occurred_on=A_DATE,
            fees=(TransferFeeInput(account_id=source, amount=Decimal("10"), label="Bank fee"),),
        )

        # WHEN
        result = await create_transfer(command, uow)

        # THEN
        fee = uow.committed_aggregates[result.fee_transaction_ids[0]]
        assert fee.usd_amount is None
        assert fee.fx_rate is None
        assert fee.fx_source is None

    async def test_unknown_source_account_raises_not_found(self):
        """
        GIVEN a create command whose source account does not exist
        WHEN the handler runs
        THEN AccountNotFoundError is raised and nothing is committed (ADR-130, ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        destination = _seed_account(uow)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await create_transfer(
                CreateTransfer(
                    user_id=A_USER,
                    from_account_id=uuid4(),
                    to_account_id=destination,
                    amount_out=Decimal("1"),
                    amount_in=Decimal("1"),
                    occurred_on=A_DATE,
                ),
                uow,
            )
        assert uow.committed_transfers == {}

    async def test_foreign_destination_account_is_not_found(self):
        """
        GIVEN a destination account owned by another user
        WHEN the caller creates a transfer into it
        THEN AccountNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        source = _seed_account(uow, user_id=A_USER)
        foreign = _seed_account(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await create_transfer(
                CreateTransfer(
                    user_id=A_USER,
                    from_account_id=source,
                    to_account_id=foreign,
                    amount_out=Decimal("1"),
                    amount_in=Decimal("1"),
                    occurred_on=A_DATE,
                ),
                uow,
            )

    async def test_foreign_fee_account_is_not_found(self):
        """
        GIVEN a fee charged to an account owned by another user
        WHEN the caller creates the transfer
        THEN AccountNotFoundError is raised and nothing is committed (ADR-130, ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        source = _seed_account(uow)
        destination = _seed_account(uow)
        foreign = _seed_account(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await create_transfer(
                CreateTransfer(
                    user_id=A_USER,
                    from_account_id=source,
                    to_account_id=destination,
                    amount_out=Decimal("1"),
                    amount_in=Decimal("1"),
                    occurred_on=A_DATE,
                    fees=(TransferFeeInput(account_id=foreign, amount=Decimal("5"), label="Bad fee"),),
                ),
                uow,
            )
        assert uow.committed_transfers == {}


class TestDeleteTransferHandler:
    """The delete handler is owner-scoped and leaves fee expenses untouched."""

    def _seed_transfer(self, uow: FakeUnitOfWork, *, user_id: str = A_USER) -> UUID:
        """Place a committed transfer directly in the unit of work's store."""
        transfer = build_transfer(
            transfer_id=uuid4(),
            from_account_id=uuid4(),
            to_account_id=uuid4(),
            amount_out=Decimal("1000"),
            amount_in=Decimal("1000"),
            occurred_on=A_DATE,
            user_id=user_id,
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        uow.committed_transfers[transfer.id] = transfer
        return transfer.id

    async def test_deletes_owned_transfer(self):
        """
        GIVEN an owned transfer
        WHEN the delete handler runs
        THEN the transfer is removed and the deletion is committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transfer_id = self._seed_transfer(uow)

        # WHEN
        await delete_transfer(DeleteTransfer(id=transfer_id, user_id=A_USER), uow)

        # THEN
        assert transfer_id not in uow.committed_transfers
        assert uow.committed is True

    async def test_missing_transfer_raises_not_found(self):
        """
        GIVEN no transfer with the requested id
        WHEN the delete handler runs
        THEN TransferNotFoundError is raised (mapped to 404 at the boundary)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(TransferNotFoundError):
            await delete_transfer(DeleteTransfer(id=uuid4(), user_id=A_USER), uow)

    async def test_cross_tenant_delete_is_not_found(self):
        """
        GIVEN a transfer owned by user A
        WHEN user B attempts to delete it
        THEN TransferNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        transfer_id = self._seed_transfer(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(TransferNotFoundError):
            await delete_transfer(DeleteTransfer(id=transfer_id, user_id=ANOTHER_USER), uow)
        assert transfer_id in uow.committed_transfers
