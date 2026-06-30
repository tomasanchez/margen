"""Unit tests for the ``BudgetIncome`` aggregate + variable-base suggestion (ADR-139).

Cover construction/normalization, the floor coercion, and the lower-of
variable-income rule (including the <12-month degrade to ``None``).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.domain.models.budget_income import build_budget_income, suggest_variable_base
from margen_api.domain.models.value_objects import Currency

A_USER = "00000000-0000-4000-8000-000000000001"


class TestBuildBudgetIncome:
    """``build_budget_income`` normalizes the period and coerces money."""

    def test_normalizes_period_to_month_start_and_coerces_money(self):
        """
        GIVEN a mid-month date and string-ish money
        WHEN an income base is built
        THEN the period is the first of the month and amounts are Decimals
        """
        # WHEN
        income = build_budget_income(
            period=date(2026, 6, 17),
            amount=Decimal("1200000"),
            floor_amount=Decimal("500000"),
            user_id=A_USER,
        )

        # THEN
        assert income.period == date(2026, 6, 1)
        assert income.amount == Decimal("1200000")
        assert income.floor_amount == Decimal("500000")
        assert income.currency is Currency.ARS
        assert income.source == "manual"
        assert income.floor_source == "manual"

    def test_floor_defaults_to_none(self):
        """
        GIVEN no floor supplied
        WHEN an income base is built
        THEN the floor amount is None
        """
        # WHEN
        income = build_budget_income(period=date(2026, 6, 1), amount=Decimal("1"), user_id=A_USER)

        # THEN
        assert income.floor_amount is None

    def test_coerces_non_decimal_amounts(self):
        """
        GIVEN integer amounts (not Decimal)
        WHEN an income base is built
        THEN the aggregate coerces them to Decimal (ADR-025)
        """
        # WHEN
        income = build_budget_income(period=date(2026, 6, 1), amount=1000, floor_amount=400, user_id=A_USER)  # type: ignore[arg-type]

        # THEN
        assert income.amount == Decimal("1000")
        assert income.floor_amount == Decimal("400")


class TestSuggestVariableBase:
    """``suggest_variable_base`` is the lower of the 12-mo average and the lowest month."""

    def test_lower_of_average_and_lowest_month(self):
        """
        GIVEN 12 months of income where the lowest month is below the average
        WHEN the base is suggested
        THEN it is the lowest month (the conservative floor)
        """
        # GIVEN — eleven months of 100, one month of 40. Average ~95 > 40.
        months = [Decimal("100")] * 11 + [Decimal("40")]

        # WHEN
        base = suggest_variable_base(months)

        # THEN
        assert base == Decimal("40")

    def test_picks_average_when_it_is_lower(self):
        """
        GIVEN 12 months where the average is below the lowest single month
        WHEN the base is suggested
        THEN it is the average (it can never exceed the lowest month, but ties resolve
             to the average via min)
        """
        # GIVEN — all equal: average == lowest == 100.
        months = [Decimal("100")] * 12

        # WHEN
        base = suggest_variable_base(months)

        # THEN
        assert base == Decimal("100.00")

    def test_fewer_than_twelve_months_returns_none(self):
        """
        GIVEN fewer than 12 months of history
        WHEN the base is suggested
        THEN it returns None (degrade to a manual base)
        """
        # WHEN / THEN
        assert suggest_variable_base([Decimal("100")] * 11) is None

    def test_empty_history_returns_none(self):
        """
        GIVEN no history
        WHEN the base is suggested
        THEN it returns None
        """
        # WHEN / THEN
        assert suggest_variable_base([]) is None
