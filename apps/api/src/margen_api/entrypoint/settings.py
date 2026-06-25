"""Application settings REST entrypoint (ADR-054, ADR-030, ADR-110).

Two endpoints over the per-user ``app_settings`` table: a read that returns the
authenticated caller's preferences and a partial PATCH that updates any subset of
them. The GET serves the settings surface via the read-only
:class:`AbstractSettingsReader` scoped to ``user.id``; the PATCH dispatches
:class:`UpdateSettings` (stamped with ``user.id``) through the bus, which
validates and merges only the provided fields on the owner's row, get-or-creating
it on first write (ADR-110) -- the reader itself never writes. Responses use the
``ResponseModel[T]`` envelope with camelCase JSON (ADR-030). The Monotributo
category lives here too (ADR-054), so changing it via PATCH is picked up by the
next ``GET /monotributo`` (ADR-052).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from margen_api.domain.models.monotributo_scale import UnknownCategoryError
from margen_api.domain.models.settings import (
    UnknownDisplayCurrencyError,
    UnknownFxRateTypeError,
)
from margen_api.entrypoint.dependencies import AuthUser, Bus, SettingsReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.settings_schemas import SettingsResponse, SettingsUpdateRequest

router = APIRouter(prefix="/settings", tags=["Settings"])


@router.get(
    "",
    name="Get settings",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[SettingsResponse],
)
async def get_settings(reader: SettingsReader, user: AuthUser) -> ResponseModel[SettingsResponse]:
    """Return the caller's application settings (ADR-054, ADR-110).

    Reads the owner's ``app_settings`` row via the read-only reader, scoped to
    ``user.id``, and echoes the documented defaults when the caller has no row yet
    so the settings surface always has a complete payload to render (the row is
    lazily created on the first PATCH, ADR-110).
    """
    settings = await reader.get_settings(user.id)
    return ResponseModel(data=SettingsResponse.from_read_model(settings))


@router.patch(
    "",
    name="Update settings",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[SettingsResponse],
)
async def update_settings(
    body: SettingsUpdateRequest,
    bus: Bus,
    user: AuthUser,
) -> ResponseModel[SettingsResponse]:
    """Partially update the caller's application settings and return the result (ADR-054, ADR-110).

    Dispatches ``UpdateSettings`` (stamped with ``user.id``) through the bus, which
    validates each provided field (currency, FX default, category), merges only
    those fields on the owner's ``app_settings`` row through the unit of work --
    get-or-creating it on first write (ADR-110) -- and returns the resulting
    settings. An unknown currency, FX default, or category maps to ``422``
    (ADR-030); the next ``GET /monotributo`` re-snapshots with the new category
    (ADR-052).
    """
    try:
        settings = await bus.handle(body.to_command(user.id))
    except (UnknownDisplayCurrencyError, UnknownFxRateTypeError, UnknownCategoryError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    return ResponseModel(data=SettingsResponse.from_read_model(settings))
