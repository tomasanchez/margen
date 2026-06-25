"""Frozen Pydantic command for the application settings (ADR-054, ADR-110).

A partial update of the caller's per-user settings row: each field is optional so
the PATCH endpoint can change one preference without disturbing the others. The
command is immutable and boundary-agnostic; it carries the owner explicitly
(ADR-108) so the handler scopes the merge to that user's row, get-or-creating a
default row on first write (ADR-110).
"""

from __future__ import annotations

from margen_api.domain.messages import Command


class UpdateSettings(Command):
    """Request to update the caller's per-user application settings (ADR-054, ADR-110).

    The PATCH settings endpoint dispatches this to change any subset of the
    preferences. The handler validates each provided field -- currency against
    ``{ARS, USD}``, the FX default against ``{MEP, official}``, and the category
    against the AFIP A-K scale (ADR-046) -- normalizes them, then merges only the
    provided fields on the owner's ``app_settings`` row through the unit of work,
    get-or-creating a default row scoped to ``user_id`` when none exists yet
    (ADR-110). A subsequent ``GET /monotributo`` re-snapshots with the new category
    (ADR-052).

    Attributes:
        user_id: The owner whose settings row is updated. The command carries it
            explicitly (ADR-108); the PATCH endpoint passes the authenticated
            caller. The settings row is scoped to and get-or-created for this user
            (ADR-110).
        preferred_display_currency: The display currency (``"ARS"`` or ``"USD"``)
            to set; ``None`` leaves it unchanged (ADR-056).
        fx_default_rate_type: The default FX rate type (``"MEP"`` or ``"official"``)
            to set; ``None`` leaves it unchanged.
        monotributo_current_category: The category letter A-K to set; ``None``
            leaves it unchanged.
        monotributo_activity_type: The activity type (``"services"`` or
            ``"bienes"``) to set; ``None`` leaves it unchanged.
    """

    user_id: str
    preferred_display_currency: str | None = None
    fx_default_rate_type: str | None = None
    monotributo_current_category: str | None = None
    monotributo_activity_type: str | None = None
