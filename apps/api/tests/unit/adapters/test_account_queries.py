"""Unit tests for the account-queries adapter helpers (ADR-122, ADR-025).

The reader's SQL aggregation is covered end to end by the e2e tier on in-memory
SQLite; this module covers the pure ``_as_decimal`` coercion that protects against
a driver returning a float for a summed money column (ADR-025).
"""

from __future__ import annotations

from decimal import Decimal

from margen_api.adapters.account_queries import _as_decimal


class TestAsDecimal:
    """A SUM result is coerced to ``Decimal`` regardless of the driver's type."""

    async def test_decimal_passes_through(self):
        """
        GIVEN a value already a Decimal
        WHEN it is coerced
        THEN the same Decimal is returned
        """
        # WHEN / THEN
        assert _as_decimal(Decimal("12.34")) == Decimal("12.34")

    async def test_float_is_coerced_to_decimal(self):
        """
        GIVEN a float (as SQLite may return for a summed NUMERIC)
        WHEN it is coerced
        THEN a Decimal is returned (ADR-025)
        """
        # WHEN
        result = _as_decimal(100.0)

        # THEN
        assert result == Decimal("100.0")
        assert isinstance(result, Decimal)
