"""Unit tests for the pure budgets-vs-actuals assembly (ADR-125).

I/O-free tests over :mod:`margen_api.service_layer.budgets`: they verify the join
of per-category targets and per-category spend into one line per expense category,
the ``remaining = target - spent`` math (null when no target), that every budgetable
category appears even with no spend/target, and that a category with spend but no
budget membership (e.g. ``Uncategorized``) still surfaces.
"""

from __future__ import annotations

from decimal import Decimal

from margen_api.service_layer.budgets import (
    BUDGETABLE_CATEGORIES,
    budgetable_categories,
    build_budget_lines,
    build_saving_lines,
)


class TestBudgetableCategories:
    """The line set unions known expense categories, targets and spend."""

    def test_excludes_income_and_includes_all_expense_categories(self):
        """
        GIVEN no targets and no spend
        WHEN the budgetable categories are computed
        THEN every known expense category appears and Income is excluded
        """
        # WHEN
        categories = budgetable_categories({}, {})

        # THEN
        assert "Income" not in categories
        assert set(categories) == BUDGETABLE_CATEGORIES
        assert categories == sorted(categories)  # deterministic order

    def test_surfaces_spent_only_custom_category(self):
        """
        GIVEN spend in a category outside the known set (e.g. Uncategorized)
        WHEN the budgetable categories are computed
        THEN that category is included alongside the known ones
        """
        # WHEN
        categories = budgetable_categories({}, {"Uncategorized": Decimal("10")})

        # THEN
        assert "Uncategorized" in categories


class TestBuildBudgetLines:
    """Lines pair target with spend and derive remaining."""

    def test_target_and_spend_yield_remaining(self):
        """
        GIVEN a category with a target and some spend
        WHEN the lines are built
        THEN the line carries target, spent and remaining = target - spent
        """
        # WHEN
        lines = build_budget_lines({"Food": Decimal("50000")}, {"Food": Decimal("20000")})
        food = next(line for line in lines if line.category == "Food")

        # THEN
        assert food.target == Decimal("50000")
        assert food.spent == Decimal("20000")
        assert food.remaining == Decimal("30000")

    def test_unset_target_yields_null_target_and_remaining(self):
        """
        GIVEN a category with spend but no target
        WHEN the lines are built
        THEN target and remaining are None while spent reflects the actual
        """
        # WHEN
        lines = build_budget_lines({}, {"Transport": Decimal("8000")})
        transport = next(line for line in lines if line.category == "Transport")

        # THEN
        assert transport.target is None
        assert transport.remaining is None
        assert transport.spent == Decimal("8000")

    def test_no_spend_defaults_to_zero(self):
        """
        GIVEN a category with neither target nor spend
        WHEN the lines are built
        THEN it appears with spent 0 and a null target/remaining (Housing, ADR-140)
        """
        # WHEN
        lines = build_budget_lines({}, {})
        housing = next(line for line in lines if line.category == "Housing")

        # THEN
        assert housing.spent == Decimal(0)
        assert housing.target is None
        assert housing.remaining is None

    def test_lines_are_sorted_by_category(self):
        """
        GIVEN several categories with targets and spend
        WHEN the lines are built
        THEN they come back sorted by category name (deterministic for the client)
        """
        # WHEN
        lines = build_budget_lines({"Health": Decimal("1")}, {"Food": Decimal("2")})
        categories = [line.category for line in lines]

        # THEN
        assert categories == sorted(categories)


class TestBuildSavingLines:
    """``build_saving_lines`` projects bucket allocations, computing percent of income."""

    def test_computes_percent_against_income(self):
        """
        GIVEN saving bucket amounts and a positive income base
        WHEN the lines are built
        THEN each line carries its amount and its percent of income (one decimal)
        """
        # WHEN
        lines = build_saving_lines({"EmergencyFund": Decimal("70000")}, Decimal("1000000"))

        # THEN
        assert lines[0].bucket == "EmergencyFund"
        assert lines[0].amount == Decimal("70000")
        assert lines[0].percent == Decimal("7.0")

    def test_percent_is_none_without_income(self):
        """
        GIVEN saving bucket amounts but no income base
        WHEN the lines are built
        THEN percent is None (no base to compute against)
        """
        # WHEN
        lines = build_saving_lines({"EmergencyFund": Decimal("70000")}, None)

        # THEN
        assert lines[0].percent is None

    def test_percent_is_none_for_zero_income(self):
        """
        GIVEN a zero income base
        WHEN the lines are built
        THEN percent is None (cannot divide by zero)
        """
        # WHEN
        lines = build_saving_lines({"EmergencyFund": Decimal("70000")}, Decimal("0"))

        # THEN
        assert lines[0].percent is None

    def test_ignores_non_bucket_keys_and_sorts(self):
        """
        GIVEN a stray non-bucket key alongside real buckets
        WHEN the lines are built
        THEN only known buckets surface, sorted by bucket name
        """
        # WHEN
        lines = build_saving_lines(
            {"FxHedge": Decimal("30000"), "EmergencyFund": Decimal("70000"), "Bogus": Decimal("1")},
            Decimal("1000000"),
        )

        # THEN
        assert [line.bucket for line in lines] == ["EmergencyFund", "FxHedge"]
