"""Unit tests for the pure inflation-reprice math (ADR-137).

Cover the rounding, the zero-inflation identity, and the additive step-up.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from margen_api.domain.models.reprice import reprice_cap


class TestRepriceCap:
    """``reprice_cap`` grows a cap by monthly inflation then adds a known step-up."""

    def test_applies_monthly_inflation_rounded_to_cents(self):
        """
        GIVEN a cap and a monthly inflation percentage
        WHEN the cap is repriced
        THEN it grows by the percentage, rounded to cents
        """
        # WHEN
        result = reprice_cap(Decimal("100000"), Decimal("2.1"))

        # THEN — 100000 * 1.021 = 102100.00
        assert result == Decimal("102100.00")

    def test_rounds_half_up_to_cents(self):
        """
        GIVEN a reprice that lands on a sub-cent fraction
        WHEN the cap is repriced
        THEN the result is rounded half-up to two decimals
        """
        # WHEN — 1000 * 1.0205 = 1020.50 exactly; use a value forcing rounding.
        result = reprice_cap(Decimal("333.33"), Decimal("2.1"))

        # THEN — 333.33 * 1.021 = 340.32993 -> 340.33
        assert result == Decimal("340.33")

    def test_zero_inflation_returns_cap_quantized(self):
        """
        GIVEN a zero monthly inflation and no step-up
        WHEN the cap is repriced
        THEN the cap is returned unchanged (quantized to cents)
        """
        # WHEN
        result = reprice_cap(Decimal("50000"), Decimal("0"))

        # THEN
        assert result == Decimal("50000.00")

    def test_adds_step_up_after_inflation(self):
        """
        GIVEN a step-up (a known discrete jump like a rent index)
        WHEN the cap is repriced
        THEN the step-up is added on top of the inflated cap
        """
        # WHEN — 100000 * 1.02 = 102000.00, + 15000 step-up.
        result = reprice_cap(Decimal("100000"), Decimal("2"), Decimal("15000"))

        # THEN
        assert result == Decimal("117000.00")

    @pytest.mark.parametrize(
        ("cap", "infl", "step_up", "expected"),
        [
            (Decimal("0"), Decimal("2.1"), Decimal("0"), Decimal("0.00")),
            (Decimal("1000"), Decimal("-50"), Decimal("0"), Decimal("500.00")),
            (Decimal("1000"), Decimal("0"), Decimal("250"), Decimal("1250.00")),
        ],
    )
    def test_edge_cases(self, cap: Decimal, infl: Decimal, step_up: Decimal, expected: Decimal):
        """
        GIVEN edge inputs (zero cap, deflation, step-up only)
        WHEN the cap is repriced
        THEN the result matches the closed-form expectation
        """
        # WHEN / THEN
        assert reprice_cap(cap, infl, step_up) == expected
