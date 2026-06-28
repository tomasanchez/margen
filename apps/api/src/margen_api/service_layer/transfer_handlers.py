"""Application handlers for the transfer aggregate (ADR-135, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain;
handlers contain no SQLAlchemy and no validation of their own (AGENTS.md). Every
write is owner-scoped (ADR-130): both transfer accounts and every fee account must
belong to the caller, or the boundary answers 404 (ADR-111). A transfer create also
records each fee as an expense transaction in the "Fees" category, all in one unit
of work (ADR-135).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.transfer import CreateTransfer, DeleteTransfer, TransferFeeInput
from margen_api.domain.models.exceptions import AccountNotFoundError, TransferNotFoundError
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.transfer import build_transfer
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# The category every transfer fee expense is filed under (ADR-135). Added to the
# known category set in ``value_objects.KNOWN_CATEGORIES``.
FEES_CATEGORY = "Fees"


@dataclass(frozen=True, slots=True)
class TransferCreated:
    """Result of creating a transfer plus its fee expenses (ADR-135).

    Attributes:
        transfer_id: The identity of the newly persisted transfer.
        fee_transaction_ids: The identities of the fee expense transactions created
            in the same unit of work, in fee order; empty when no fees were charged.
    """

    transfer_id: UUID
    fee_transaction_ids: tuple[UUID, ...]


async def _require_owned_account_currency(uow: AbstractUnitOfWork, account_id: UUID, user_id: str) -> Currency:
    """Return a fee account's native currency, verifying the caller owns it (ADR-130, ADR-135).

    A fee expense is recorded in its account's native currency (ADR-123), so the
    handler loads the account to read its currency and confirm ownership in one step.
    A missing account, or one owned by another user, raises
    :class:`AccountNotFoundError`, which the boundary maps to 404 (ADR-111).

    Args:
        uow: The unit of work providing the account repository (inside its boundary).
        account_id: The fee account being charged.
        user_id: The authenticated owner the account must belong to.

    Returns:
        The account's native currency.

    Raises:
        AccountNotFoundError: When ``account_id`` is not an account owned by the user.
    """
    account = await uow.accounts.get(account_id, user_id)
    if account is None:
        raise AccountNotFoundError(account_id)
    return account.currency


async def _check_account_ownership(uow: AbstractUnitOfWork, account_id: UUID, user_id: str) -> None:
    """Verify ``account_id`` is an account the caller owns (ADR-130, ADR-135).

    Args:
        uow: The unit of work providing the account repository (inside its boundary).
        account_id: The account being referenced (a transfer leg).
        user_id: The authenticated owner the account must belong to.

    Raises:
        AccountNotFoundError: When ``account_id`` is not an account owned by the user.
    """
    if not await uow.accounts.owns(account_id, user_id):
        raise AccountNotFoundError(account_id)


async def create_transfer(command: CreateTransfer, uow: AbstractUnitOfWork) -> TransferCreated:
    """Create a transfer between two of the caller's accounts and record its fees (ADR-135, ADR-130).

    Within a single unit of work (ADR-135): verifies both transfer accounts belong to
    the caller (ADR-130), builds the transfer through the domain factory so invariants
    run (``from != to``, positive legs, ADR-031), stages it, then for each fee verifies
    the fee account is the caller's and stages a ``kind=expense`` transaction in the
    "Fees" category in that account's native currency (ADR-123). All inserts share one
    commit; the transfer and its fee expenses land atomically.

    Args:
        command: The validated create request carrying the transfer legs and fees.
        uow: The unit of work providing the transfer + account + transaction
            repositories.

    Returns:
        A :class:`TransferCreated` with the transfer id and the fee transaction ids.

    Raises:
        AccountNotFoundError: When either transfer account, or any fee account, is not
            one of the caller's accounts (mapped to 404 at the boundary, ADR-111).
        SameAccountTransferError: When the source and destination accounts match
            (mapped to 422 at the boundary, ADR-031).
        InvalidAmountError: When a transfer leg is not a positive magnitude (422).
    """
    now = datetime.now(UTC)
    transfer = build_transfer(
        transfer_id=uuid4(),
        created_at=now,
        updated_at=now,
        from_account_id=command.from_account_id,
        to_account_id=command.to_account_id,
        amount_out=command.amount_out,
        amount_in=command.amount_in,
        occurred_on=command.occurred_on,
        note=command.note,
        user_id=command.user_id,
    )
    async with uow:
        await _check_account_ownership(uow, command.from_account_id, command.user_id)
        await _check_account_ownership(uow, command.to_account_id, command.user_id)
        uow.transfers.add(transfer)
        fee_ids = tuple(
            [await _record_fee(uow, fee, command.occurred_on, now, command.user_id) for fee in command.fees]
        )
        await uow.commit()
    return TransferCreated(transfer_id=transfer.id, fee_transaction_ids=fee_ids)


async def _record_fee(
    uow: AbstractUnitOfWork,
    fee: TransferFeeInput,
    occurred_on: date,
    now: datetime,
    user_id: str,
) -> UUID:
    """Stage one fee as an expense transaction in the "Fees" category (ADR-135).

    The fee expense lives on its own account in that account's native currency
    (ADR-123); ownership of the fee account is verified before staging (ADR-130). The
    aggregate is built through the domain factory so invariants run (positive amount,
    ADR-031) and is stamped with ``user_id`` so it is owned like any manual expense
    (ADR-108).

    Args:
        uow: The unit of work whose transaction repository stages the expense.
        fee: The validated fee input (account, amount, label).
        occurred_on: The transfer's date; the fee expense shares it.
        now: The shared creation/update timestamp for the operation.
        user_id: The authenticated owner the fee expense belongs to (ADR-108).

    Returns:
        The generated identity of the staged fee expense transaction.

    Raises:
        AccountNotFoundError: When the fee account is not one of the caller's accounts.
    """
    currency = await _require_owned_account_currency(uow, fee.account_id, user_id)
    expense = build_transaction(
        transaction_id=uuid4(),
        created_at=now,
        updated_at=now,
        occurred_on=occurred_on,
        name=fee.label,
        kind=Kind.EXPENSE,
        amount=fee.amount,
        currency=currency,
        category=FEES_CATEGORY,
        account_id=fee.account_id,
        user_id=user_id,
    )
    uow.transactions.add(expense)
    return expense.id


async def delete_transfer(command: DeleteTransfer, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a transfer by identity (ADR-135, ADR-130).

    Scoped to ``command.user_id`` so a cross-tenant delete removes nothing and the
    boundary answers 404 (ADR-111). The fee expenses created with the transfer are
    independent expense transactions and are NOT deleted (ADR-135).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the transfer repository.

    Raises:
        TransferNotFoundError: When no transfer matches ``command.id`` for the owner.
    """
    async with uow:
        removed = await uow.transfers.delete(command.id, command.user_id)
        if not removed:
            raise TransferNotFoundError(command.id)
        await uow.commit()
