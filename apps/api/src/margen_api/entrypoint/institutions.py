"""Institutions REST entrypoint (ADR-130, ADR-134).

Owner-scoped CRUD over the institution aggregate (list / create / update), exposed
under ``/institutions`` with the ``ResponseModel[T]`` envelope and camelCase JSON
(ADR-030). Writes go through the message bus as commands; reads use the query-side
:class:`AbstractInstitutionReader` (ADR-028). Domain invariant violations (ADR-031)
are translated to HTTP here:

- :class:`InstitutionNotFoundError` -> ``404 Not Found`` (incl. cross-tenant, ADR-111)
- :class:`UnknownInstitutionTypeError` / :class:`EmptyNameError` ->
  ``422 Unprocessable Entity``
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.models.exceptions import (
    EmptyNameError,
    InstitutionNotFoundError,
    UnknownInstitutionTypeError,
)
from margen_api.entrypoint.dependencies import AuthUser, Bus, InstitutionReader
from margen_api.entrypoint.institutions_schemas import (
    InstitutionCreateRequest,
    InstitutionPatchRequest,
    InstitutionResponse,
)
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/institutions", tags=["Institutions"])

# Invariant violations the domain raises that map to HTTP 422 (ADR-031).
_INVARIANT_VIOLATIONS = (UnknownInstitutionTypeError, EmptyNameError)


def _not_found(institution_id: UUID) -> HTTPException:
    """Build the 404 raised when no institution matches an identity (ADR-111, ADR-134)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Institution {institution_id} not found.",
    )


@router.get(
    "",
    name="List institutions",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[InstitutionResponse],
)
async def list_institutions(reader: InstitutionReader, user: AuthUser) -> ResponseModel[InstitutionResponse]:
    """List the authenticated user's institutions, newest-first (ADR-130, ADR-134).

    Scoped to ``user.id`` so a caller only sees their own institutions (ADR-130).
    """
    models = await reader.list_institutions(user.id)
    return ResponseModel(data=[InstitutionResponse.from_read_model(model) for model in models])


@router.post(
    "",
    name="Create institution",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[InstitutionResponse],
)
async def create_institution(
    body: InstitutionCreateRequest,
    bus: Bus,
    reader: InstitutionReader,
    user: AuthUser,
) -> ResponseModel[InstitutionResponse]:
    """Create an institution owned by the caller and return it (ADR-130, ADR-134).

    Dispatches a ``CreateInstitution`` command (stamped with ``user.id``) through
    the message bus, then re-reads the owner's institutions to return the created
    one. Lenient validation applies (ADR-031): an empty ``name`` or an unknown
    ``type`` yields ``422``.
    """
    try:
        institution_id = await bus.handle(body.to_command(user.id))
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_institutions(user.id)
    created = next((model for model in models if model.id == institution_id), None)
    if created is None:  # pragma: no cover - the row was just committed
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Created institution could not be read back.",
        )
    return ResponseModel(data=InstitutionResponse.from_read_model(created))


@router.patch(
    "/{institution_id}",
    name="Update institution",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[InstitutionResponse],
)
async def update_institution(
    institution_id: UUID,
    body: InstitutionPatchRequest,
    bus: Bus,
    reader: InstitutionReader,
    user: AuthUser,
) -> ResponseModel[InstitutionResponse]:
    """Partially update the caller's institution and return it (ADR-130, ADR-134).

    Omitted fields are left unchanged (ADR-028); ``updatedAt`` is bumped by the
    handler. The patch is scoped to ``user.id``: a missing id OR another user's id
    both surface :class:`InstitutionNotFoundError` mapped to ``404`` (ADR-111);
    invariant violations (ADR-031) map to ``422``.
    """
    try:
        await bus.handle(body.to_command(institution_id, user.id))
    except InstitutionNotFoundError as error:
        raise _not_found(institution_id) from error
    except _INVARIANT_VIOLATIONS as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    models = await reader.list_institutions(user.id)
    updated = next((model for model in models if model.id == institution_id), None)
    if updated is None:  # pragma: no cover - the row was just updated
        raise _not_found(institution_id)
    return ResponseModel(data=InstitutionResponse.from_read_model(updated))
