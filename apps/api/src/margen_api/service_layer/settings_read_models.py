"""Read model for the application settings query side (ADR-054).

A purpose-built, immutable DTO for the settings surface: the preferred display
currency, the default FX rate type, and the Monotributo category / activity type
carried over from the retired ``monotributo_config`` (ADR-048, superseded). The
display currency is a frontend display transform (ADR-056); the backend only
stores the preference here -- no money lives in settings (ADR-025). Deliberately
separate from any write aggregate so the query side evolves independently
(AGENTS.md reader ports + read models).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AppSettings:
    """The single-row application settings (ADR-054).

    Attributes:
        preferred_display_currency: A 3-letter currency code (``"ARS"`` or
            ``"USD"``); a frontend display preference only (ADR-056).
        fx_default_rate_type: The default FX rate-type token (``"MEP"`` or
            ``"official"``) the frontend uses to convert for the USD display.
        monotributo_current_category: The category letter A-K in effect for the
            Monotributo trailing-12-month calculation (ADR-046).
        monotributo_activity_type: ``"services"`` or ``"bienes"`` (MVP uses
            services).
        monotributo_enabled: Whether the optional Monotributo module is enabled
            for this user (ADR-126). ``False`` hides the Monotributo UI; brand-new
            users default to ``False`` while existing users were back-filled to
            ``True``. Gates the UI only -- the M2M capture endpoint (ADR-064) is
            unaffected.
    """

    preferred_display_currency: str
    fx_default_rate_type: str
    monotributo_current_category: str
    monotributo_activity_type: str
    monotributo_enabled: bool
