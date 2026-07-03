"""Debts REST entrypoint (ADR-187, ADR-130).

Owner-scoped CRUD over the debt aggregate (list / create / update / delete), exposed
under ``/debts`` with the ``ResponseModel[T]`` envelope and camelCase JSON (ADR-030).
Writes go through the message bus as commands; reads use the query-side
:class:`AbstractDebtReader` (ADR-028). A debt is a manual, balance-bearing liability whose
``currentBalance`` feeds the net-worth ``liabilities.other`` leg (ADR-187). Domain
invariant violations (ADR-031) are translated to HTTP here:

- :class:`DebtNotFoundError` -> ``404 Not Found`` (incl. cross-tenant, ADR-111)
- :class:`UnknownCurrencyError` / :class:`EmptyNameError` / :class:`InvalidBalanceError`
  -> ``422 Unprocessable Entity``
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.commands.debt import DeleteDebt
from margen_api.domain.models.exceptions import (
    DebtNotFoundError,
    EmptyNameError,
    InvalidBalanceError,
    UnknownCurrencyError,
)
from margen_api.entrypoint.debts_schemas import (
    DebtCreateRequest,
    DebtPatchRequest,
    DebtResponse,
)
from margen_api.entrypoint.dependencies import AuthUser, Bus, DebtReader
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/debts", tags=["Debts"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031).
_INVARIANT_VIOLATIONS = (UnknownCurrencyError, EmptyNameError, InvalidBalanceError)


def _not_found(debt_id: UUID) -> HTTPException:
    """Build the 404 raised when no debt matches an identity (ADR-111, ADR-187)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Debt {debt_id} not found.",
    )


@router.get(
    "",
    name="List debts",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[DebtResponse],
)
async def list_debts(reader: DebtReader, user: AuthUser) -> ResponseModel[DebtResponse]:
    """List the authenticated user's debts, newest-first (ADR-187, ADR-130).

    Scoped to ``user.id`` so a caller only sees their own debts (ADR-130).
    """
    models = await reader.list_debts(user.id)
    return ResponseModel(data=[DebtResponse.from_read_model(model) for model in models])


@router.post(
    "",
    name="Create debt",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[DebtResponse],
)
async def create_debt(
    body: DebtCreateRequest,
    bus: Bus,
    reader: DebtReader,
    user: AuthUser,
) -> ResponseModel[DebtResponse]:
    """Create a debt owned by the caller and return it (ADR-187, ADR-130).

    Dispatches a ``CreateDebt`` command (stamped with ``user.id``) through the message
    bus, then re-reads the owner's debts to return the created one. Lenient validation
    applies (ADR-031): an empty ``name``, an unknown ``currency`` or a negative
    ``currentBalance`` yields ``422``.
    """
    try:
        debt_id = await bus.handle(body.to_command(user.id))
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_debts(user.id)
    created = next((model for model in models if model.id == debt_id), None)
    if created is None:  # pragma: no cover - the row was just committed
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Created debt could not be read back.",
        )
    return ResponseModel(data=DebtResponse.from_read_model(created))


@router.patch(
    "/{debt_id}",
    name="Update debt",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[DebtResponse],
)
async def update_debt(
    debt_id: UUID,
    body: DebtPatchRequest,
    bus: Bus,
    reader: DebtReader,
    user: AuthUser,
) -> ResponseModel[DebtResponse]:
    """Partially update the caller's debt and return it (ADR-187, ADR-130).

    Omitted fields are left unchanged (ADR-028); ``updatedAt`` is bumped by the handler.
    The patch is scoped to ``user.id``: a missing id OR another user's id both surface
    :class:`DebtNotFoundError` mapped to ``404`` (ADR-111); invariant violations (ADR-031)
    map to ``422``.
    """
    try:
        await bus.handle(body.to_command(debt_id, user.id))
    except DebtNotFoundError as error:
        raise _not_found(debt_id) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_debts(user.id)
    updated = next((model for model in models if model.id == debt_id), None)
    if updated is None:  # pragma: no cover - the row was just updated
        raise _not_found(debt_id)
    return ResponseModel(data=DebtResponse.from_read_model(updated))


@router.delete(
    "/{debt_id}",
    name="Delete debt",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_debt(debt_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Delete the caller's debt by identity (ADR-187, ADR-130).

    Dispatches a ``DeleteDebt`` command scoped to ``user.id``: a missing id or another
    user's id surfaces a not-found mapped to ``404`` (ADR-111).
    """
    try:
        await bus.handle(DeleteDebt(id=debt_id, user_id=user.id))
    except DebtNotFoundError as error:
        raise _not_found(debt_id) from error
