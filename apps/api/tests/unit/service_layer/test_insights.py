"""Unit tests for the pure monthly-insights assembly (ADR-060, ADR-061, ADR-032).

These exercise the biggest-mover selection, the recurring passthrough, the
elapsed-fraction / savings projection and the full assembly with plain objects
and no database (ADR-032). They are the fast tier that proves the computation is
correct independently of SQL.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.service_layer.insights import (
    build_monthly_insights,
    build_recurring,
    build_savings,
    elapsed_fraction,
    select_top_mover,
)
from margen_api.service_layer.insights_read_models import LatestUsdInvoice

JUNE = date(2026, 6, 1)


class TestSelectTopMover:
    """``select_top_mover`` picks the largest positive month-over-month mover."""

    def test_picks_largest_positive_delta(self):
        """
        GIVEN two categories that both grew versus the prior month
        WHEN the top mover is selected
        THEN the category with the larger percent increase wins
        """
        # GIVEN — Food +100% (150->300), Transport +50% (200->300).
        month_totals = {"Food": Decimal("300"), "Transport": Decimal("300")}
        prior_totals = {"Food": Decimal("150"), "Transport": Decimal("200")}

        # WHEN
        mover = select_top_mover(month_totals, prior_totals)

        # THEN
        assert mover is not None
        assert mover.category == "Food"
        assert mover.delta_pct == Decimal("100")

    def test_none_when_no_prior_base(self):
        """
        GIVEN categories with no prior-month presence
        WHEN the top mover is selected
        THEN there is no base to compare against, so None
        """
        # GIVEN
        month_totals = {"Food": Decimal("300"), "Rent": Decimal("700")}

        # WHEN
        mover = select_top_mover(month_totals, {})

        # THEN
        assert mover is None

    def test_none_when_prior_is_zero(self):
        """
        GIVEN a category whose prior total is exactly 0
        WHEN the top mover is selected
        THEN division by zero is avoided and the category is skipped -> None
        """
        # WHEN
        mover = select_top_mover({"Food": Decimal("300")}, {"Food": Decimal("0")})

        # THEN
        assert mover is None

    def test_none_when_nothing_increased(self):
        """
        GIVEN categories that stayed flat or fell versus the prior month
        WHEN the top mover is selected
        THEN no positive mover exists, so None
        """
        # GIVEN — Food flat, Rent fell.
        month_totals = {"Food": Decimal("100"), "Rent": Decimal("50")}
        prior_totals = {"Food": Decimal("100"), "Rent": Decimal("200")}

        # WHEN
        mover = select_top_mover(month_totals, prior_totals)

        # THEN
        assert mover is None

    def test_tiebreak_is_stable_on_category_name(self):
        """
        GIVEN two categories with the same positive percent increase
        WHEN the top mover is selected
        THEN the tie breaks on the category name for a deterministic result
        """
        # GIVEN — both doubled (+100%); "Food" sorts before "Rent".
        month_totals = {"Rent": Decimal("200"), "Food": Decimal("200")}
        prior_totals = {"Rent": Decimal("100"), "Food": Decimal("100")}

        # WHEN
        mover = select_top_mover(month_totals, prior_totals)

        # THEN
        assert mover is not None
        assert mover.category == "Food"


class TestBuildRecurring:
    """``build_recurring`` passes count + total through, or returns None."""

    def test_passes_count_and_total_through(self):
        """
        GIVEN a non-zero recurring count and total
        WHEN the recurring footprint is built
        THEN it carries the count and total verbatim
        """
        # WHEN
        recurring = build_recurring(3, Decimal("1250.00"))

        # THEN
        assert recurring is not None
        assert recurring.count == 3
        assert recurring.total == Decimal("1250.00")

    def test_none_when_count_is_zero(self):
        """
        GIVEN a recurring count of 0
        WHEN the recurring footprint is built
        THEN there is nothing to report, so None
        """
        # WHEN
        recurring = build_recurring(0, Decimal("0"))

        # THEN
        assert recurring is None


class TestElapsedFraction:
    """``elapsed_fraction`` is 1 for a past month and day/days for the current."""

    def test_past_month_is_fully_elapsed(self):
        """
        GIVEN a reference in a later month than the requested month
        WHEN the elapsed fraction is computed
        THEN the month is fully elapsed -> 1
        """
        # WHEN — June requested, reference in July.
        fraction = elapsed_fraction(JUNE, date(2026, 7, 5))

        # THEN
        assert fraction == Decimal(1)

    def test_current_month_is_day_over_days_in_month(self):
        """
        GIVEN a reference partway through the requested month
        WHEN the elapsed fraction is computed
        THEN it is the reference day over the days in that month
        """
        # WHEN — June has 30 days; the 15th -> 15/30.
        fraction = elapsed_fraction(JUNE, date(2026, 6, 15))

        # THEN
        assert fraction == Decimal(15) / Decimal(30)

    def test_current_month_clamps_to_one_on_last_day(self):
        """
        GIVEN a reference on the last day of the requested month
        WHEN the elapsed fraction is computed
        THEN it is clamped to 1 (never scales a finished month up)
        """
        # WHEN — June 30th -> 30/30 = 1.
        fraction = elapsed_fraction(JUNE, date(2026, 6, 30))

        # THEN
        assert fraction == Decimal(1)


class TestBuildSavings:
    """``build_savings`` projects the current month and reports the actual past."""

    def test_current_month_is_projected_by_elapsed_fraction(self):
        """
        GIVEN income and expenses partway through the current month
        WHEN savings are built
        THEN the actual savings are scaled to month-end by 1/elapsed_fraction and
             flagged projected
        """
        # GIVEN — actual savings = 3000 - 1500 = 1500, halfway through June (15/30).
        # WHEN
        savings = build_savings(
            income_total=Decimal("3000"),
            expense_total=Decimal("1500"),
            month=JUNE,
            reference=date(2026, 6, 15),
        )

        # THEN — 1500 / (15/30) = 3000 projected.
        assert savings.is_projected is True
        assert savings.elapsed_fraction == Decimal(15) / Decimal(30)
        assert savings.amount == Decimal("3000")

    def test_past_month_is_actual(self):
        """
        GIVEN a reference in a later month than the requested month
        WHEN savings are built
        THEN the actual savings are returned, not projected, with fraction 1
        """
        # WHEN — June requested, reference in July.
        savings = build_savings(
            income_total=Decimal("3000"),
            expense_total=Decimal("1500"),
            month=JUNE,
            reference=date(2026, 7, 1),
        )

        # THEN
        assert savings.is_projected is False
        assert savings.elapsed_fraction == Decimal(1)
        assert savings.amount == Decimal("1500")

    def test_savings_is_income_kinds_minus_expenses(self):
        """
        GIVEN inflow that exceeds nothing and expenses that exceed inflow
        WHEN savings are built for a past month
        THEN the figure is income minus expenses and may be negative
        """
        # WHEN — spent more than earned.
        savings = build_savings(
            income_total=Decimal("500"),
            expense_total=Decimal("800"),
            month=JUNE,
            reference=date(2026, 7, 1),
        )

        # THEN
        assert savings.amount == Decimal("-300")


class TestBuildMonthlyInsights:
    """``build_monthly_insights`` assembles the optional members correctly."""

    def test_assembles_all_members(self):
        """
        GIVEN raw aggregates for a month with a mover, recurring rows and a USD invoice
        WHEN the monthly insights are assembled
        THEN every fact is populated and the month key is the requested month
        """
        # GIVEN
        latest = LatestUsdInvoice(
            usd=Decimal("100"),
            rate=Decimal("1200"),
            rate_type="MEP",
            occurred_on=date(2026, 6, 10),
        )

        # WHEN — past month (reference in July) so savings are actual.
        insights = build_monthly_insights(
            JUNE,
            date(2026, 7, 1),
            month_category_totals={"Food": Decimal("300")},
            prior_category_totals={"Food": Decimal("150")},
            recurring_count=2,
            recurring_total=Decimal("900"),
            income_total=Decimal("3000"),
            expense_total=Decimal("1500"),
            latest_usd_invoice=latest,
        )

        # THEN
        assert insights.month == "2026-06"
        assert insights.top_category_mover is not None
        assert insights.top_category_mover.category == "Food"
        assert insights.recurring is not None
        assert insights.recurring.count == 2
        assert insights.savings.amount == Decimal("1500")
        assert insights.savings.is_projected is False
        assert insights.latest_usd_invoice is latest

    def test_empty_month_has_none_facts_and_zero_savings(self):
        """
        GIVEN an empty month — no categories, no recurring rows, no USD invoice
        WHEN the monthly insights are assembled
        THEN the optional facts are None and savings are 0
        """
        # WHEN — past month so savings are actual (0 - 0).
        insights = build_monthly_insights(
            JUNE,
            date(2026, 7, 1),
            month_category_totals={},
            prior_category_totals={},
            recurring_count=0,
            recurring_total=Decimal("0"),
            income_total=Decimal("0"),
            expense_total=Decimal("0"),
            latest_usd_invoice=None,
        )

        # THEN
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
        assert insights.savings.amount == Decimal("0")
