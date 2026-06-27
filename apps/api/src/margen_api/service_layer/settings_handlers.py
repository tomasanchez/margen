"""Application handler for the settings update (ADR-054, ADR-110).

The PATCH settings endpoint dispatches :class:`UpdateSettings`, and this handler
validates each provided field, merges only those fields onto the owner's
``app_settings`` row through the unit of work (get-or-creating it on first write,
ADR-110), and returns the resulting settings. Validation lives in the domain
rules (currency / FX default in :mod:`margen_api.domain.models.settings`, category
in the AFIP scale); the handler contains no SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from margen_api.domain.commands.settings import UpdateSettings
from margen_api.domain.models.monotributo_scale import (
    KNOWN_CATEGORIES,
    UnknownCategoryError,
)
from margen_api.domain.models.settings import (
    KNOWN_DISPLAY_CURRENCIES,
    KNOWN_FX_DEFAULT_RATE_TYPES,
    UnknownDisplayCurrencyError,
    UnknownFxRateTypeError,
)
from margen_api.service_layer.settings_read_models import AppSettings
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork


async def update_settings(command: UpdateSettings, uow: AbstractUnitOfWork) -> AppSettings:
    """Merge the provided settings fields and return the resulting row (ADR-054, ADR-110).

    Validates each field that was provided: the display currency against
    ``{ARS, USD}``, the FX default against ``{MEP, official}``, and the
    Monotributo category against the AFIP A-K scale (derived from the scale, never
    a duplicated list). Normalizes the provided values, merges only those fields
    on the owner's ``app_settings`` row through the unit of work (get-or-creating
    it scoped to ``command.user_id`` on first write, ADR-110), and commits. The
    resulting settings are returned so the boundary can echo them without a second
    read (a subsequent ``GET /monotributo`` re-snapshots with the new category,
    ADR-052).

    Args:
        command: The validated update request; it carries the owner ``user_id``
            (ADR-108) plus the optional fields, only the provided ones applied.
        uow: The unit of work providing the settings repository.

    Returns:
        The resulting :class:`AppSettings` after the merge.

    Raises:
        UnknownDisplayCurrencyError: When a provided currency is not ``ARS``/``USD``.
        UnknownFxRateTypeError: When a provided FX default is not ``MEP``/``official``.
        UnknownCategoryError: When a provided category is not a known A-K letter.
            The entrypoint maps each of these to ``422`` (ADR-030).
    """
    currency = _validated_currency(command.preferred_display_currency)
    fx_default = _validated_fx_default(command.fx_default_rate_type)
    category = _validated_category(command.monotributo_current_category)
    activity_type = command.monotributo_activity_type.strip() if command.monotributo_activity_type is not None else None
    async with uow:
        settings = await uow.settings.upsert_settings(
            command.user_id,
            preferred_display_currency=currency,
            fx_default_rate_type=fx_default,
            monotributo_current_category=category,
            monotributo_activity_type=activity_type,
            monotributo_enabled=command.monotributo_enabled,
        )
        await uow.commit()
    return settings


def _validated_currency(value: str | None) -> str | None:
    """Normalize and validate the display currency, or pass through ``None``."""
    if value is None:
        return None
    currency = value.strip().upper()
    if currency not in KNOWN_DISPLAY_CURRENCIES:
        raise UnknownDisplayCurrencyError(value)
    return currency


def _validated_fx_default(value: str | None) -> str | None:
    """Normalize and validate the FX default rate type, or pass through ``None``."""
    if value is None:
        return None
    rate_type = value.strip()
    if rate_type not in KNOWN_FX_DEFAULT_RATE_TYPES:
        raise UnknownFxRateTypeError(value)
    return rate_type


def _validated_category(value: str | None) -> str | None:
    """Normalize and validate the Monotributo category, or pass through ``None``."""
    if value is None:
        return None
    category = value.strip().upper()
    if category not in KNOWN_CATEGORIES:
        raise UnknownCategoryError(value)
    return category
