"""Transaction REST entrypoint (ADR-030).

CRUD over the transaction aggregate, exposed under ``/transactions`` with the
``ResponseModel[T]`` envelope and camelCase JSON aliases matching the frontend
mock (ADR-024). Writes go through the message bus as commands; reads use the
query-side :class:`AbstractTransactionReader` (ADR-028). Domain invariant
violations (ADR-031) are translated to HTTP at this boundary:

- :class:`TransactionNotFoundError` / :class:`OffsetTargetNotFoundError` -> ``404 Not Found``
- :class:`InvalidAmountError` / :class:`UnknownKindError` /
  :class:`UnknownCurrencyError` / :class:`OffsetTargetNotExpenseError` -> ``422 Unprocessable Entity``

Filtering, sorting and pagination query params (``type``, ``currency``,
``category``, ``bank``, ``date``, ``search``) are a **planned extension for #14**
and are intentionally not implemented here (ADR-030).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.commands.transaction import DeleteTransaction
from margen_api.domain.models.exceptions import (
    AccountNotFoundError,
    InvalidAmountError,
    OffsetTargetNotExpenseError,
    OffsetTargetNotFoundError,
    TransactionNotFoundError,
    UnknownCurrencyError,
    UnknownKindError,
)
from margen_api.entrypoint.dependencies import AuthUser, Bus, TransactionReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.transactions_schemas import (
    InvalidDocumentBase64Error,
    TransactionCreateRequest,
    TransactionFxSnapshotRequest,
    TransactionPatchRequest,
    TransactionResponse,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/transactions", tags=["Transactions"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031). Linking a
# reimbursement to a non-expense target is a genuine invariant breach (ADR-159), so it
# joins the 422 set; a missing/cross-tenant offset target is a 404 (handled separately).
_INVARIANT_VIOLATIONS = (
    InvalidAmountError,
    UnknownKindError,
    UnknownCurrencyError,
    OffsetTargetNotExpenseError,
)


def _not_found(transaction_id: UUID) -> HTTPException:
    """Build the 404 raised when no transaction matches an identity (ADR-030)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Transaction {transaction_id} not found.",
    )


@router.get(
    "",
    name="List transactions",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[TransactionResponse],
)
async def list_transactions(reader: TransactionReader, user: AuthUser) -> ResponseModel[TransactionResponse]:
    """List the authenticated user's transactions, newest-first (ADR-030, ADR-108).

    Returns the owner's rows ordered by ``occurredOn`` descending (``createdAt`` as
    a stable tiebreak), scoped to ``user.id`` so a caller only sees its own data
    (ADR-108). The UI filters client-side for now; server-side
    filter / sort / pagination params (``type``, ``currency``, ``category``,
    ``bank``, ``date``, ``search``) are a planned extension for #14 and are not
    implemented yet.
    """
    models = await reader.list_transactions(user.id)
    return ResponseModel(data=[TransactionResponse.from_read_model(model) for model in models])


@router.post(
    "",
    name="Create transaction",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[TransactionResponse],
)
async def create_transaction(
    body: TransactionCreateRequest,
    bus: Bus,
    reader: TransactionReader,
    user: AuthUser,
) -> ResponseModel[TransactionResponse]:
    """Create a transaction owned by the caller and return it (ADR-030, ADR-108).

    Dispatches a ``CreateTransaction`` command (stamped with ``user.id``) through
    the message bus, then re-reads the created row via the reader — scoped to the
    same owner — so the response carries the server-managed identity and
    timestamps. Lenient validation applies (ADR-031): a non-positive ``amountNum``
    or an unknown ``kind`` / ``currency`` yields ``422``; USD without a rate is
    accepted. An optional ``document`` attaches an imported invoice PDF (base64),
    stored as a side record in the same unit of work (ADR-070, ADR-071); a malformed
    ``pdfBase64`` yields ``422``.
    """
    try:
        command = body.to_command(user.id)
    except InvalidDocumentBase64Error as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    try:
        transaction_id = await bus.handle(command)
    except AccountNotFoundError as error:
        # Linking a missing/cross-tenant account is a not-found, never a leak (ADR-130, ADR-111).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Account {error.account_id} not found.",
        ) from error
    except OffsetTargetNotFoundError as error:
        # Linking a reimbursement to a missing/cross-tenant expense is a not-found,
        # never a leak of another tenant's rows (ADR-159, ADR-130, ADR-111).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Offset target transaction {error.transaction_id} not found.",
        ) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    model = await reader.get_transaction(transaction_id, user.id)
    if model is None:  # pragma: no cover - the row was just committed
        log.error("Created transaction %s could not be re-read.", transaction_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Created transaction could not be read back.",
        )
    return ResponseModel(data=TransactionResponse.from_read_model(model))


@router.get(
    "/{transaction_id}",
    name="Get transaction",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[TransactionResponse],
)
async def get_transaction(
    transaction_id: UUID,
    reader: TransactionReader,
    user: AuthUser,
) -> ResponseModel[TransactionResponse]:
    """Fetch one of the caller's transactions by identity (ADR-030, ADR-111).

    Scoped to ``user.id`` via filter-in-reader: an id that does not exist OR that
    belongs to another user both raise ``404`` — existence is never leaked across
    tenants (ADR-111).
    """
    model = await reader.get_transaction(transaction_id, user.id)
    if model is None:
        raise _not_found(transaction_id)
    return ResponseModel(data=TransactionResponse.from_read_model(model))


@router.patch(
    "/{transaction_id}",
    name="Update transaction",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[TransactionResponse],
)
async def update_transaction(
    transaction_id: UUID,
    body: TransactionPatchRequest,
    bus: Bus,
    reader: TransactionReader,
    user: AuthUser,
) -> ResponseModel[TransactionResponse]:
    """Partially update the caller's transaction and return it (ADR-030, ADR-108).

    Omitted fields are left unchanged (ADR-028); ``updatedAt`` is bumped by the
    handler. The patch is scoped to ``user.id`` (set on the command): a missing id
    OR another user's id both surface :class:`TransactionNotFoundError` mapped to
    ``404`` (ADR-111); invariant violations (ADR-031) map to ``422``.
    """
    try:
        await bus.handle(body.to_command(transaction_id, user.id))
    except TransactionNotFoundError as error:
        raise _not_found(transaction_id) from error
    except AccountNotFoundError as error:
        # Linking a missing/cross-tenant account is a not-found, never a leak (ADR-130, ADR-111).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Account {error.account_id} not found.",
        ) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    model = await reader.get_transaction(transaction_id, user.id)
    if model is None:  # pragma: no cover - the row was just updated
        raise _not_found(transaction_id)
    return ResponseModel(data=TransactionResponse.from_read_model(model))


@router.put(
    "/{transaction_id}/fx",
    name="Set transaction FX snapshot",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[TransactionResponse],
)
async def set_transaction_fx(
    transaction_id: UUID,
    body: TransactionFxSnapshotRequest,
    bus: Bus,
    reader: TransactionReader,
    user: AuthUser,
) -> ResponseModel[TransactionResponse]:
    """Set or replace the FX snapshot on the caller's transaction (ADR-148, ADR-149).

    Dispatches a ``SetTransactionFxSnapshot`` command (stamped with ``user.id``)
    through the message bus: the client supplies the ARS-per-1-USD ``fxRate`` and its
    ``fxSource`` provenance, and the handler re-materializes ``usd_amount`` as pure
    arithmetic — the backend never calls an FX feed (ADR-149). Scoped to ``user.id``:
    a missing id OR another user's id both surface :class:`TransactionNotFoundError`
    mapped to ``404`` (ADR-111); a non-positive ``fxRate`` is rejected at boundary
    validation with ``422``. Powers the client import rate-fill and the one-time
    historical backfill (ADR-149/150).
    """
    try:
        await bus.handle(body.to_command(transaction_id, user.id))
    except TransactionNotFoundError as error:
        raise _not_found(transaction_id) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    model = await reader.get_transaction(transaction_id, user.id)
    if model is None:  # pragma: no cover - the row was just updated
        raise _not_found(transaction_id)
    return ResponseModel(data=TransactionResponse.from_read_model(model))


@router.delete(
    "/{transaction_id}",
    name="Delete transaction",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_transaction(transaction_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Hard-delete one of the caller's transactions by identity (ADR-030, ADR-108).

    Returns ``204 No Content`` on success. The delete is scoped to ``user.id``: a
    missing id OR another user's id both surface
    :class:`TransactionNotFoundError` mapped to ``404`` (ADR-111).
    """
    try:
        await bus.handle(DeleteTransaction(id=transaction_id, user_id=user.id))
    except TransactionNotFoundError as error:
        raise _not_found(transaction_id) from error
