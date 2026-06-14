"""Unit tests for the settings domain rules (ADR-054).

These exercise the known-value sets and the domain error classes with plain
objects -- no database, no HTTP (ADR-032). They prove the bounded sets stay tied
to the ``Currency`` / ``FxRateType`` enums and that each error carries the
offending value for the boundary to turn into a 422 message (ADR-030).
"""

from __future__ import annotations

from margen_api.domain.models.settings import (
    KNOWN_DISPLAY_CURRENCIES,
    KNOWN_FX_DEFAULT_RATE_TYPES,
    UnknownDisplayCurrencyError,
    UnknownFxRateTypeError,
)
from margen_api.domain.models.value_objects import Currency, FxRateType


class TestKnownSets:
    """The accepted sets stay derived from the value-object enums (ADR-054/056)."""

    def test_display_currencies_match_currency_enum(self):
        """GIVEN the currency enum THEN the display set is exactly its values (ARS, USD)."""
        assert frozenset({c.value for c in Currency}) == KNOWN_DISPLAY_CURRENCIES
        assert frozenset({"ARS", "USD"}) == KNOWN_DISPLAY_CURRENCIES

    def test_fx_defaults_are_the_live_rate_subset(self):
        """GIVEN the FX rate types THEN the settable default set is the live MEP/official subset."""
        assert frozenset({FxRateType.MEP.value, FxRateType.OFFICIAL.value}) == KNOWN_FX_DEFAULT_RATE_TYPES
        # MANUAL / CONFIGURED_DEFAULT are not user-selectable defaults.
        assert FxRateType.MANUAL.value not in KNOWN_FX_DEFAULT_RATE_TYPES


class TestDomainErrors:
    """Each error carries the offending value so the boundary can build a 422 message."""

    def test_unknown_display_currency_carries_value(self):
        """GIVEN a bad currency WHEN raised THEN it carries the value in attr and message."""
        error = UnknownDisplayCurrencyError("EUR")
        assert error.currency == "EUR"
        assert "EUR" in str(error)

    def test_unknown_fx_rate_type_carries_value(self):
        """GIVEN a bad FX default WHEN raised THEN it carries the value in attr and message."""
        error = UnknownFxRateTypeError("crypto")
        assert error.rate_type == "crypto"
        assert "crypto" in str(error)
