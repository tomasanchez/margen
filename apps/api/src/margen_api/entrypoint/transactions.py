"""Transaction REST entrypoint (ADR-030).

CRUD over the transaction aggregate, exposed under ``/transactions`` with the
``ResponseModel[T]`` envelope and camelCase JSON aliases matching the frontend
mock (ADR-024). Writes go through the message bus as commands; reads use the
query-side :class:`AbstractTransactionReader` (ADR-028). Domain invariant
violations (ADR-031) are translated to HTTP at this boundary:

- :class:`TransactionNotFoundError` -> ``404 Not Found``
- :class:`InvalidAmountError` / :class:`UnknownKindError` /
  :class:`UnknownCurrencyError` -> ``422 Unprocessable Entity``

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
    InvalidAmountError,
    TransactionNotFoundError,
    UnknownCurrencyError,
    UnknownKindError,
)
from margen_api.entrypoint.dependencies import Bus, TransactionReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.transactions_schemas import (
    InvalidDocumentBase64Error,
    TransactionCreateRequest,
    TransactionPatchRequest,
    TransactionResponse,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/transactions", tags=["Transactions"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031).
_INVARIANT_VIOLATIONS = (InvalidAmountError, UnknownKindError, UnknownCurrencyError)


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
async def list_transactions(reader: TransactionReader) -> ResponseModel[TransactionResponse]:
    """List every transaction, newest-first (ADR-030).

    Returns all rows ordered by ``occurredOn`` descending (``createdAt`` as a
    stable tiebreak). The UI filters client-side for now; server-side
    filter / sort / pagination params (``type``, ``currency``, ``category``,
    ``bank``, ``date``, ``search``) are a planned extension for #14 and are not
    implemented yet.
    """
    models = await reader.list_transactions()
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
) -> ResponseModel[TransactionResponse]:
    """Create a transaction and return the persisted entity (ADR-030).

    Dispatches a ``CreateTransaction`` command through the message bus, then
    re-reads the created row via the reader so the response carries the
    server-managed identity and timestamps. Lenient validation applies
    (ADR-031): a non-positive ``amountNum`` or an unknown ``kind`` / ``currency``
    yields ``422``; USD without a rate is accepted. An optional ``document``
    attaches an imported invoice PDF (base64), stored as a side record in the same
    unit of work (ADR-070, ADR-071); a malformed ``pdfBase64`` yields ``422``.
    """
    try:
        command = body.to_command()
    except InvalidDocumentBase64Error as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    try:
        transaction_id = await bus.handle(command)
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    model = await reader.get_transaction(transaction_id)
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
) -> ResponseModel[TransactionResponse]:
    """Fetch one transaction by identity (ADR-030).

    Raises ``404`` when no row matches the supplied UUID.
    """
    model = await reader.get_transaction(transaction_id)
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
) -> ResponseModel[TransactionResponse]:
    """Partially update a transaction and return the refreshed entity (ADR-030).

    Omitted fields are left unchanged (ADR-028); ``updatedAt`` is bumped by the
    handler. Maps :class:`TransactionNotFoundError` to ``404`` and invariant
    violations (ADR-031) to ``422``.
    """
    try:
        await bus.handle(body.to_command(transaction_id))
    except TransactionNotFoundError as error:
        raise _not_found(transaction_id) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    model = await reader.get_transaction(transaction_id)
    if model is None:  # pragma: no cover - the row was just updated
        raise _not_found(transaction_id)
    return ResponseModel(data=TransactionResponse.from_read_model(model))


@router.delete(
    "/{transaction_id}",
    name="Delete transaction",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_transaction(transaction_id: UUID, bus: Bus) -> None:
    """Hard-delete a transaction by identity (ADR-030).

    Returns ``204 No Content`` on success. Maps
    :class:`TransactionNotFoundError` to ``404``.
    """
    try:
        await bus.handle(DeleteTransaction(id=transaction_id))
    except TransactionNotFoundError as error:
        raise _not_found(transaction_id) from error
