"""Transfers REST entrypoint (ADR-135, ADR-130).

Owner-scoped create / list / delete over the transfer aggregate, exposed under
``/transfers`` with the ``ResponseModel[T]`` envelope and camelCase JSON (ADR-030).
Writes go through the message bus as commands; reads use the query-side
:class:`AbstractTransferReader` (ADR-028). A transfer moves money between two of the
caller's accounts and is NOT a transaction (ADR-135); its optional fees are recorded
as expense transactions in the same unit of work. Domain invariant violations
(ADR-031) are translated to HTTP here:

- :class:`AccountNotFoundError` -> ``404 Not Found`` (a transfer/fee account must be
  one of the caller's; a missing/foreign one is a 404, ADR-130/111)
- :class:`TransferNotFoundError` -> ``404 Not Found`` (incl. cross-tenant, ADR-111)
- :class:`SameAccountTransferError` / :class:`InvalidAmountError` -> ``422``
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.commands.transfer import DeleteTransfer
from margen_api.domain.models.exceptions import (
    AccountNotFoundError,
    InvalidAmountError,
    SameAccountTransferError,
    TransferNotFoundError,
)
from margen_api.entrypoint.dependencies import AuthUser, Bus, TransferReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.transfers_schemas import (
    TransferCreatedResponse,
    TransferCreateRequest,
    TransferResponse,
)
from margen_api.service_layer.transfer_handlers import TransferCreated

router = APIRouter(prefix="/transfers", tags=["Transfers"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031).
_INVARIANT_VIOLATIONS = (SameAccountTransferError, InvalidAmountError)
# Domain not-found errors that map to HTTP 404 (ADR-111, ADR-130).
_NOT_FOUND_ERRORS = (AccountNotFoundError, TransferNotFoundError)


@router.get(
    "",
    name="List transfers",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[TransferResponse],
)
async def list_transfers(reader: TransferReader, user: AuthUser) -> ResponseModel[TransferResponse]:
    """List the authenticated user's transfers, newest-first (ADR-135, ADR-130).

    Scoped to ``user.id`` so a caller only sees their own transfers (ADR-130).
    """
    models = await reader.list_transfers(user.id)
    return ResponseModel(data=[TransferResponse.from_read_model(model) for model in models])


@router.post(
    "",
    name="Create transfer",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[TransferCreatedResponse],
)
async def create_transfer(
    body: TransferCreateRequest,
    bus: Bus,
    user: AuthUser,
) -> ResponseModel[TransferCreatedResponse]:
    """Create a transfer between two of the caller's accounts and record its fees (ADR-135, ADR-130).

    Dispatches a ``CreateTransfer`` command (stamped with ``user.id``) through the
    message bus and returns the created transfer plus the ids of the fee expense
    transactions created in the same unit of work (ADR-135). Referencing an account
    the caller does not own (a transfer leg or a fee account) is a ``404`` (ADR-111);
    a same-account transfer or a non-positive leg is a ``422`` (ADR-031).
    """
    try:
        result = await bus.handle(body.to_command(user.id))
    except _NOT_FOUND_ERRORS as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    return ResponseModel(data=_to_created_response(body, result))


@router.delete(
    "/{transfer_id}",
    name="Delete transfer",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_transfer(transfer_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Delete the caller's transfer by identity (ADR-135, ADR-130).

    Dispatches a ``DeleteTransfer`` command scoped to ``user.id``: a missing id or
    another user's id surfaces a not-found mapped to ``404`` (ADR-111). Deleting a
    transfer does NOT delete the fee expenses it created — they are independent
    expense transactions (ADR-135).
    """
    try:
        await bus.handle(DeleteTransfer(id=transfer_id, user_id=user.id))
    except TransferNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Transfer {transfer_id} not found.",
        ) from error


def _to_created_response(body: TransferCreateRequest, result: TransferCreated) -> TransferCreatedResponse:
    """Build the create response from the request body and the handler result (ADR-030).

    The handler returns the generated transfer id and the fee transaction ids; the
    transfer's own fields echo the validated request (the handler stored them as
    given), so a re-read is unnecessary for the create response.
    """
    return TransferCreatedResponse(
        id=result.transfer_id,
        from_account_id=body.from_account_id,
        to_account_id=body.to_account_id,
        amount_out=body.amount_out,
        amount_in=body.amount_in,
        occurred_on=body.occurred_on,
        note=body.note,
        fee_transaction_ids=list(result.fee_transaction_ids),
    )
