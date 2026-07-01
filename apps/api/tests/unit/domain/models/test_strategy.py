"""Unit tests for the pure floor + strategy math (ADR-143, budget-design §9.1).

Cover ``compute_floor``, ``income_pressure`` boundaries (1.3 / 2.5),
``suggest_strategy`` branches, and the ``floor_guard``.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from margen_api.domain.models.saving_profiles import SavingProfile
from margen_api.domain.models.strategy import (
    compute_floor,
    floor_guard,
    income_pressure,
    suggest_strategy,
)
from margen_api.domain.models.value_objects import is_essential


class TestComputeFloor:
    """``compute_floor`` sums the essential spend targets."""

    def test_sums_only_essentials(self):
        """
        GIVEN spend targets across essential and non-essential categories
        WHEN the floor is computed
        THEN only essential categories contribute
        """
        # GIVEN
        targets = {
            "Housing": Decimal("300000"),
            "Food": Decimal("150000"),
            "Entertainment": Decimal("50000"),  # not essential
            "Shopping": Decimal("40000"),  # not essential
        }

        # WHEN
        floor = compute_floor(targets, is_essential)

        # THEN
        assert floor == Decimal("450000")

    def test_no_essentials_is_zero(self):
        """
        GIVEN only non-essential targets
        WHEN the floor is computed
        THEN it is zero
        """
        # WHEN / THEN
        assert compute_floor({"Entertainment": Decimal("10")}, is_essential) == Decimal("0")


class TestIncomePressure:
    """``income_pressure`` segments by the income/floor ratio at 1.3 / 2.5."""

    @pytest.mark.parametrize(
        ("income", "floor", "expected"),
        [
            (Decimal("129"), Decimal("100"), "constrained"),  # 1.29x < 1.3
            (Decimal("130"), Decimal("100"), "stable"),  # exactly 1.3x -> stable
            (Decimal("250"), Decimal("100"), "stable"),  # exactly 2.5x -> stable
            (Decimal("251"), Decimal("100"), "comfortable"),  # > 2.5x
        ],
    )
    def test_boundaries(self, income: Decimal, floor: Decimal, expected: str):
        """
        GIVEN income/floor ratios around the 1.3 and 2.5 boundaries
        WHEN the pressure is classified
        THEN it matches the segment (1.3 and 2.5 fall in 'stable')
        """
        # WHEN / THEN
        assert income_pressure(income, floor) == expected

    def test_zero_floor_is_comfortable(self):
        """
        GIVEN a zero floor (nothing essential budgeted)
        WHEN the pressure is classified
        THEN there is no floor pressure -> comfortable
        """
        # WHEN / THEN
        assert income_pressure(Decimal("1"), Decimal("0")) == "comfortable"


class TestSuggestStrategy:
    """``suggest_strategy`` maps adequacy + debt ratio to a profile."""

    def test_constrained_income_suggests_conservative(self):
        """
        GIVEN income below 1.3x the floor
        WHEN a strategy is suggested
        THEN it is conservative
        """
        # WHEN / THEN
        assert suggest_strategy(Decimal("120"), Decimal("100"), Decimal("0")) is SavingProfile.CONSERVATIVE

    def test_high_debt_keeps_conservative_even_when_comfortable(self):
        """
        GIVEN comfortable income but a high debt-service ratio (> 20%)
        WHEN a strategy is suggested
        THEN it stays conservative (kill expensive debt first)
        """
        # GIVEN — income 300, floor 100 (3x, comfortable), debt 90 (30% of income).
        # WHEN / THEN
        assert suggest_strategy(Decimal("300"), Decimal("100"), Decimal("90")) is SavingProfile.CONSERVATIVE

    def test_comfortable_with_manageable_debt_suggests_aggressive(self):
        """
        GIVEN comfortable income and low debt
        WHEN a strategy is suggested
        THEN it is aggressive
        """
        # WHEN / THEN
        assert suggest_strategy(Decimal("300"), Decimal("100"), Decimal("10")) is SavingProfile.AGGRESSIVE

    def test_stable_income_suggests_balanced(self):
        """
        GIVEN stable income (1.3-2.5x) and low debt
        WHEN a strategy is suggested
        THEN it is balanced (the default)
        """
        # WHEN / THEN
        assert suggest_strategy(Decimal("200"), Decimal("100"), Decimal("0")) is SavingProfile.BALANCED

    def test_zero_income_does_not_divide_by_zero(self):
        """
        GIVEN zero income with a floor
        WHEN a strategy is suggested
        THEN it is constrained (and no ZeroDivisionError on the debt ratio)
        """
        # WHEN / THEN
        assert suggest_strategy(Decimal("0"), Decimal("100"), Decimal("50")) is SavingProfile.CONSERVATIVE


class TestFloorGuard:
    """``floor_guard`` flags (never rebalances) when savings underfund the floor."""

    def test_breach_reports_gap(self):
        """
        GIVEN savings that leave the residual below the floor
        WHEN the guard runs
        THEN it reports a breach and the positive gap
        """
        # GIVEN — income 1000, floor 700, saving 400 -> residual 600 < 700.
        # WHEN
        guard = floor_guard(Decimal("1000"), Decimal("700"), Decimal("400"))

        # THEN
        assert guard.breached is True
        assert guard.gap == Decimal("100")

    def test_no_breach_when_residual_covers_floor(self):
        """
        GIVEN savings that leave the residual at or above the floor
        WHEN the guard runs
        THEN it reports no breach and a zero gap
        """
        # GIVEN — income 1000, floor 500, saving 400 -> residual 600 >= 500.
        # WHEN
        guard = floor_guard(Decimal("1000"), Decimal("500"), Decimal("400"))

        # THEN
        assert guard.breached is False
        assert guard.gap == Decimal("0")
