"""Accounts + net-worth REST entrypoint (ADR-122, ADR-123, ADR-130, ADR-134).

Owner-scoped CRUD over the account aggregate (list / create / update) plus a
read-only net-worth endpoint, exposed under ``/accounts`` with the
``ResponseModel[T]`` envelope and camelCase JSON (ADR-030). Writes go through the
message bus as commands; reads use the query-side :class:`AbstractAccountReader`
(ADR-028). An account is a per-currency leaf under an institution (ADR-134), so a
create carries the ``institutionId``. Domain invariant violations (ADR-031) are
translated to HTTP here:

- :class:`AccountNotFoundError` -> ``404 Not Found`` (incl. cross-tenant, ADR-111)
- :class:`InstitutionNotFoundError` -> ``404 Not Found`` (an account links one of the
  caller's institutions; a missing/foreign one is a 404, ADR-130/111)
- :class:`UnknownCurrencyError` -> ``422 Unprocessable Entity``
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.models.exceptions import (
    AccountNotFoundError,
    InstitutionNotFoundError,
    UnknownCurrencyError,
)
from margen_api.entrypoint.accounts_schemas import (
    AccountCreateRequest,
    AccountPatchRequest,
    AccountResponse,
    NetWorthResponse,
)
from margen_api.entrypoint.dependencies import AccountReader, AuthUser, Bus
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/accounts", tags=["Accounts"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031).
_INVARIANT_VIOLATIONS = (UnknownCurrencyError,)
# Domain not-found errors that map to HTTP 404 (ADR-111, ADR-130, ADR-134).
_NOT_FOUND_ERRORS = (AccountNotFoundError, InstitutionNotFoundError)


def _not_found(account_id: UUID) -> HTTPException:
    """Build the 404 raised when no account matches an identity (ADR-122, ADR-111)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Account {account_id} not found.",
    )


@router.get(
    "",
    name="List accounts",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[AccountResponse],
)
async def list_accounts(reader: AccountReader, user: AuthUser) -> ResponseModel[AccountResponse]:
    """List the authenticated user's accounts, newest-first (ADR-122, ADR-130).

    Scoped to ``user.id`` so a caller only sees their own accounts (ADR-130).
    """
    models = await reader.list_accounts(user.id)
    return ResponseModel(data=[AccountResponse.from_read_model(model) for model in models])


@router.get(
    "/net-worth",
    name="Net worth",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[NetWorthResponse],
)
async def net_worth(reader: AccountReader, user: AuthUser) -> ResponseModel[NetWorthResponse]:
    """Return the caller's net worth and per-account breakdown (ADR-122, ADR-123).

    Each account's balance is ``opening_balance + Σ signed transaction deltas`` in
    its native currency; the total sums those balances converted into the caller's
    display currency via the MEP rate (ADR-123). When no MEP rate is available the
    converted figures degrade to native (ADR-132). Scoped to ``user.id`` (ADR-130).
    """
    model = await reader.net_worth(user.id)
    return ResponseModel(data=NetWorthResponse.from_read_model(model))


@router.post(
    "",
    name="Create account",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[AccountResponse],
)
async def create_account(
    body: AccountCreateRequest,
    bus: Bus,
    reader: AccountReader,
    user: AuthUser,
) -> ResponseModel[AccountResponse]:
    """Create an account under one of the caller's institutions and return it (ADR-130, ADR-134).

    Dispatches a ``CreateAccount`` command (stamped with ``user.id``) through the
    message bus, then re-reads the owner's accounts to return the created one.
    Linking an institution the caller does not own is a ``404`` (ADR-111); an
    unknown ``currency`` is a ``422`` (lenient validation, ADR-031).
    """
    try:
        account_id = await bus.handle(body.to_command(user.id))
    except _NOT_FOUND_ERRORS as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(error),
        ) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_accounts(user.id)
    created = next((model for model in models if model.id == account_id), None)
    if created is None:  # pragma: no cover - the row was just committed
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Created account could not be read back.",
        )
    return ResponseModel(data=AccountResponse.from_read_model(created))


@router.patch(
    "/{account_id}",
    name="Update account",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[AccountResponse],
)
async def update_account(
    account_id: UUID,
    body: AccountPatchRequest,
    bus: Bus,
    reader: AccountReader,
    user: AuthUser,
) -> ResponseModel[AccountResponse]:
    """Partially update the caller's account and return it (ADR-122, ADR-130, ADR-134).

    Omitted fields are left unchanged (ADR-028); ``updatedAt`` is bumped by the
    handler. The patch is scoped to ``user.id``: a missing id, another user's id, or
    a linked institution the caller does not own all surface a not-found mapped to
    ``404`` (ADR-111); invariant violations (ADR-031) map to ``422``.
    """
    try:
        await bus.handle(body.to_command(account_id, user.id))
    except _NOT_FOUND_ERRORS as error:
        raise _not_found(account_id) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_accounts(user.id)
    updated = next((model for model in models if model.id == account_id), None)
    if updated is None:  # pragma: no cover - the row was just updated
        raise _not_found(account_id)
    return ResponseModel(data=AccountResponse.from_read_model(updated))
