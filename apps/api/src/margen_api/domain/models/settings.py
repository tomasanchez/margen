"""Domain rules for the application settings (ADR-054).

The settings surface accepts a bounded set of values, validated in the domain so
the boundary stays a thin translation layer (ADR-054). The display currency is a
frontend display preference (ADR-056) limited to the currencies the app handles
(``Currency``); the default FX rate type is limited to the user-selectable subset
of ``FxRateType`` (the live rates dolarapi.com exposes -- MEP and official). The
Monotributo category is validated separately against the AFIP A-K scale
(``monotributo_scale.KNOWN_CATEGORIES``).
"""

from __future__ import annotations

from margen_api.domain.models.value_objects import Currency, FxRateType

# Display currencies the settings surface accepts (ADR-056). Backed by the
# ``Currency`` enum so the set never drifts from the currencies the app handles.
KNOWN_DISPLAY_CURRENCIES: frozenset[str] = frozenset(currency.value for currency in Currency)

# FX rate types selectable as the display default (ADR-054/056). The MANUAL and
# CONFIGURED_DEFAULT members of ``FxRateType`` are not user-selectable defaults,
# so the settable set is the live-rate subset dolarapi.com exposes.
KNOWN_FX_DEFAULT_RATE_TYPES: frozenset[str] = frozenset({FxRateType.MEP.value, FxRateType.OFFICIAL.value})


class UnknownDisplayCurrencyError(Exception):
    """Raised when a display currency is not a known ``{ARS, USD}`` value (ADR-054).

    The settings write path raises this so the boundary can translate it into a
    ``422 Unprocessable Entity`` (ADR-030). The carried ``currency`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, currency: object) -> None:
        self.currency = currency
        super().__init__(f"unknown display currency: {currency!r} (expected one of ARS, USD)")


class UnknownFxRateTypeError(Exception):
    """Raised when an FX default is not a known ``{MEP, official}`` value (ADR-054).

    The settings write path raises this so the boundary can translate it into a
    ``422 Unprocessable Entity`` (ADR-030). The carried ``rate_type`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, rate_type: object) -> None:
        self.rate_type = rate_type
        super().__init__(f"unknown FX default rate type: {rate_type!r} (expected one of MEP, official)")
