"""Frozen Pydantic command for the application settings (ADR-054).

A partial update of the single-row settings: each field is optional so the PATCH
endpoint can change one preference without disturbing the others. The command is
immutable and boundary-agnostic; the handler validates the provided values,
merges only those fields on the unit of work, and returns the resulting settings.
"""

from __future__ import annotations

from margen_api.domain.messages import Command


class UpdateSettings(Command):
    """Request to update the single-row application settings (ADR-054).

    The PATCH settings endpoint dispatches this to change any subset of the
    preferences. The handler validates each provided field -- currency against
    ``{ARS, USD}``, the FX default against ``{MEP, official}``, and the category
    against the AFIP A-K scale (ADR-046) -- normalizes them, then merges only the
    provided fields on the single ``app_settings`` row through the unit of work. A
    subsequent ``GET /monotributo`` re-snapshots with the new category (ADR-052).

    Attributes:
        preferred_display_currency: The display currency (``"ARS"`` or ``"USD"``)
            to set; ``None`` leaves it unchanged (ADR-056).
        fx_default_rate_type: The default FX rate type (``"MEP"`` or ``"official"``)
            to set; ``None`` leaves it unchanged.
        monotributo_current_category: The category letter A-K to set; ``None``
            leaves it unchanged.
        monotributo_activity_type: The activity type (``"services"`` or
            ``"bienes"``) to set; ``None`` leaves it unchanged.
    """

    preferred_display_currency: str | None = None
    fx_default_rate_type: str | None = None
    monotributo_current_category: str | None = None
    monotributo_activity_type: str | None = None
