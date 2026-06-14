"""Unit tests for the pure monthly-summary assembly (ADR-042, ADR-032).

These exercise the trend window, share and delta-percent math with plain objects
and no database (ADR-032). They are the fast tier that proves the computation is
correct independently of SQL.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.service_layer.summaries import (
    add_months,
    build_categories,
    build_monthly_summary,
    build_trend,
    month_key,
    trend_window,
)

JUNE = date(2026, 6, 1)


class TestMonthArithmetic:
    """``month_key``, ``add_months`` and ``trend_window`` derive calendar months."""

    def test_month_key_zero_pads(self):
        """
        GIVEN an early-year date
        WHEN month_key renders it
        THEN it is zero-padded as YYYY-MM
        """
        assert month_key(date(2026, 3, 9)) == "2026-03"

    def test_add_months_crosses_year_boundary_backwards(self):
        """
        GIVEN January
        WHEN two months are subtracted
        THEN it rolls back into the prior year
        """
        assert add_months(date(2026, 1, 15), -2) == date(2025, 11, 1)

    def test_add_months_crosses_year_boundary_forwards(self):
        """
        GIVEN November
        WHEN three months are added
        THEN it rolls into the next year
        """
        assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 1)

    def test_trend_window_is_six_months_ending_at_month(self):
        """
        GIVEN June 2026
        WHEN the trend window is built
        THEN it spans Jan..Jun 2026, oldest-first
        """
        keys = [month_key(first) for first in trend_window(JUNE)]
        assert keys == ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]


class TestBuildTrend:
    """``build_trend`` fills missing months with 0 and flags the requested one."""

    def test_missing_months_default_to_zero_and_current_is_flagged(self):
        """
        GIVEN totals for only some months in the window
        WHEN the trend is built for June
        THEN absent months are 0 and only June is current
        """
        # GIVEN
        totals = {"2026-03": Decimal("100.00"), "2026-06": Decimal("250.50")}

        # WHEN
        trend = build_trend(JUNE, totals)

        # THEN
        assert [point.expenses for point in trend] == [
            Decimal(0),
            Decimal(0),
            Decimal("100.00"),
            Decimal(0),
            Decimal(0),
            Decimal("250.50"),
        ]
        assert [point.current for point in trend] == [False, False, False, False, False, True]


class TestBuildCategories:
    """``build_categories`` computes share, delta and the sort order."""

    def test_share_and_delta_and_sort(self):
        """
        GIVEN this month's and the prior month's category totals
        WHEN the breakdown is built
        THEN amounts sort descending, share is % of the month total, and delta is
             the percent change vs the prior month
        """
        # GIVEN
        month_totals = {"Food": Decimal("300"), "Rent": Decimal("700")}
        prior_totals = {"Food": Decimal("150"), "Rent": Decimal("700")}

        # WHEN
        categories = build_categories(month_totals, prior_totals)

        # THEN — sorted by amount desc: Rent (700) before Food (300).
        assert [c.category for c in categories] == ["Rent", "Food"]
        rent, food = categories
        assert rent.share == Decimal("70")
        assert food.share == Decimal("30")
        # Food doubled (150 -> 300) => +100%; Rent unchanged => 0%.
        assert food.delta_pct == Decimal("100")
        assert rent.delta_pct == Decimal("0")

    def test_delta_is_none_when_prior_absent_or_zero(self):
        """
        GIVEN a category with no prior month presence and one with a 0 prior
        WHEN the breakdown is built
        THEN delta_pct is None for both
        """
        # GIVEN
        month_totals = {"Food": Decimal("100"), "Health": Decimal("50")}
        prior_totals = {"Health": Decimal("0")}

        # WHEN
        categories = build_categories(month_totals, prior_totals)
        by_name = {c.category: c for c in categories}

        # THEN
        assert by_name["Food"].delta_pct is None
        assert by_name["Health"].delta_pct is None

    def test_share_is_zero_when_month_total_is_zero(self):
        """
        GIVEN an empty month
        WHEN the breakdown is built
        THEN it is empty (no categories, so no division by zero)
        """
        # WHEN
        categories = build_categories({}, {})

        # THEN
        assert categories == []

    def test_share_zero_branch_with_only_zero_amounts(self):
        """
        GIVEN a category whose amount is 0 (total is 0)
        WHEN the breakdown is built
        THEN its share is 0 rather than raising on division
        """
        # WHEN
        categories = build_categories({"Food": Decimal("0")}, {})

        # THEN
        assert categories[0].share == Decimal("0")


class TestBuildMonthlySummary:
    """``build_monthly_summary`` assembles the month, trend and categories."""

    def test_assembles_full_summary(self):
        """
        GIVEN raw trend and category aggregates
        WHEN the monthly summary is assembled
        THEN it carries the requested month key, the 6-point trend and categories
        """
        # WHEN
        summary = build_monthly_summary(
            JUNE,
            trend_totals={"2026-06": Decimal("250")},
            month_category_totals={"Food": Decimal("250")},
            prior_category_totals={},
        )

        # THEN
        assert summary.month == "2026-06"
        assert len(summary.trend) == 6
        assert summary.trend[-1].current is True
        assert summary.categories[0].category == "Food"
