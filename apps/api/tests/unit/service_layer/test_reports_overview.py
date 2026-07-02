"""Unit tests for the pure range-based Reports overview assembly (ADR-167, ADR-169).

These drive the I/O-free functions with plain dict aggregates (ADR-032): range
resolution (3M/6M/12M/YTD, previous windows, year boundaries, YTD prev-year), the
KPI / cash-flow / category / FX assembly, the div0 savings-rate guard, an empty
window, and a category present in the current window but absent from the previous
(delta vs 0 → None). The currency denomination itself lives in the adapter; here the
per-month maps are treated as already denominated (the ARS and USD paths differ only
in which column the adapter summed).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from margen_api.service_layer.reports_overview import (
    RANGE_3M,
    RANGE_6M,
    RANGE_12M,
    RANGE_YTD,
    UnsupportedReportsRangeError,
    build_cash_flow,
    build_category_trends,
    build_fx_summary,
    build_kpis,
    build_overview,
    resolve_windows,
)


class TestResolveWindows:
    """Range presets resolve to the current + immediately-preceding equal-length windows (ADR-169)."""

    def test_three_month_current_and_previous(self):
        """
        GIVEN the 3M preset anchored at June 2026
        WHEN the windows are resolved
        THEN the current window is Apr-Jun 2026 and the previous is Jan-Mar 2026
        """
        # WHEN
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 15))

        # THEN
        assert current == [date(2026, 4, 1), date(2026, 5, 1), date(2026, 6, 1)]
        assert previous == [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]

    def test_six_month_window_length(self):
        """
        GIVEN the 6M preset
        WHEN the windows are resolved
        THEN both windows are 6 months and contiguous
        """
        # WHEN
        current, previous = resolve_windows(RANGE_6M, date(2026, 6, 1))

        # THEN
        assert len(current) == len(previous) == 6
        assert current[0] == date(2026, 1, 1)
        assert previous == [date(2025, m, 1) for m in range(7, 13)]

    def test_twelve_month_crosses_year_boundary(self):
        """
        GIVEN the 12M preset anchored at March 2026
        WHEN the windows are resolved
        THEN the current window spans Apr 2025..Mar 2026 and the previous the year before
        """
        # WHEN
        current, previous = resolve_windows(RANGE_12M, date(2026, 3, 20))

        # THEN
        assert current[0] == date(2025, 4, 1)
        assert current[-1] == date(2026, 3, 1)
        assert previous[0] == date(2024, 4, 1)
        assert previous[-1] == date(2025, 3, 1)

    def test_ytd_current_is_jan_to_current_month(self):
        """
        GIVEN the YTD preset anchored at May 2026
        WHEN the windows are resolved
        THEN the current window is Jan-May 2026 and the previous is Jan-May 2025 (prev year)
        """
        # WHEN
        current, previous = resolve_windows(RANGE_YTD, date(2026, 5, 9))

        # THEN
        assert current == [date(2026, m, 1) for m in range(1, 6)]
        assert previous == [date(2025, m, 1) for m in range(1, 6)]

    def test_ytd_in_january_is_a_single_month(self):
        """
        GIVEN the YTD preset anchored at January
        WHEN the windows are resolved
        THEN the current window is just January and the previous is the prior January
        """
        # WHEN
        current, previous = resolve_windows(RANGE_YTD, date(2026, 1, 31))

        # THEN
        assert current == [date(2026, 1, 1)]
        assert previous == [date(2025, 1, 1)]

    def test_unsupported_range_raises(self):
        """
        GIVEN an unsupported range token
        WHEN the windows are resolved
        THEN an UnsupportedReportsRangeError is raised carrying the token
        """
        # WHEN / THEN
        with pytest.raises(UnsupportedReportsRangeError) as error:
            resolve_windows("2Y", date(2026, 6, 1))
        assert error.value.range_key == "2Y"


class TestBuildKpis:
    """The KPI strip carries the current and previous windows, guarding div0 (ADR-167)."""

    def test_income_expenses_net_and_savings_rate(self):
        """
        GIVEN per-month income and expense totals over a 3M window and its previous
        WHEN the KPIs are built
        THEN each window's income, expenses, net saved and savings rate are correct
        """
        # GIVEN
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 1))
        income = {"2026-04": Decimal("1000"), "2026-05": Decimal("2000"), "2026-06": Decimal("1000")}
        expenses = {"2026-04": Decimal("500"), "2026-06": Decimal("500")}
        prev_income = {"2026-01": Decimal("1000")}

        # WHEN
        kpis = build_kpis(
            current,
            previous,
            income_by_month={**income, **prev_income},
            expenses_by_month=expenses,
        )

        # THEN — current: income 4000, expenses 1000, net 3000, rate 75%.
        assert kpis.current.income == Decimal("4000.00")
        assert kpis.current.expenses == Decimal("1000.00")
        assert kpis.current.net_saved == Decimal("3000.00")
        assert kpis.current.savings_rate == Decimal("75")
        # previous: income 1000, expenses 0, net 1000, rate 100%.
        assert kpis.previous.income == Decimal("1000.00")
        assert kpis.previous.savings_rate == Decimal("100")

    def test_savings_rate_guards_zero_income(self):
        """
        GIVEN a window with no income but some expenses
        WHEN the KPIs are built
        THEN the savings rate is 0 (not a divide-by-zero) and net saved is negative
        """
        # GIVEN
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 1))

        # WHEN
        kpis = build_kpis(
            current,
            previous,
            income_by_month={},
            expenses_by_month={"2026-05": Decimal("300")},
        )

        # THEN
        assert kpis.current.income == Decimal("0.00")
        assert kpis.current.net_saved == Decimal("-300.00")
        assert kpis.current.savings_rate == Decimal("0")


class TestBuildCashFlow:
    """The cash-flow series is one oldest-first point per month, zero-filled (ADR-167)."""

    def test_one_point_per_month_oldest_first(self):
        """
        GIVEN income in two of three window months and one expense
        WHEN the cash-flow series is built
        THEN there is one point per month, oldest-first, missing months zero-filled
        """
        # GIVEN
        current, _ = resolve_windows(RANGE_3M, date(2026, 6, 1))

        # WHEN
        series = build_cash_flow(
            current,
            income_by_month={"2026-04": Decimal("100"), "2026-06": Decimal("200")},
            expenses_by_month={"2026-05": Decimal("50")},
        )

        # THEN
        assert [point.month for point in series] == ["2026-04", "2026-05", "2026-06"]
        assert series[0].income == Decimal("100.00") and series[0].expenses == Decimal("0.00")
        assert series[1].income == Decimal("0.00") and series[1].expenses == Decimal("50.00")
        assert series[2].income == Decimal("200.00")


class TestBuildCategoryTrends:
    """Category trends carry total, share, a 6-month sparkline and a vs-previous delta (ADR-167)."""

    def test_total_share_series_and_delta(self):
        """
        GIVEN Food and Transport spend in the current 3M window with a prior Food total
        WHEN the trends are built for a June-2026 reference
        THEN each carries its total, share of the window, a trailing-6-month sparkline
             and the delta vs the previous window (sorted by total desc)
        """
        # GIVEN — current window Apr-Jun, previous Jan-Mar.
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 1))
        by_month_category = {
            # previous window: Food 200 total.
            "2026-02": {"Food": Decimal("200")},
            # current window.
            "2026-04": {"Food": Decimal("100"), "Transport": Decimal("300")},
            "2026-06": {"Food": Decimal("300")},
        }

        # WHEN
        trends = build_category_trends(
            current,
            previous,
            date(2026, 6, 15),
            expense_by_month_category=by_month_category,
        )

        # THEN — Food total 400, Transport 300, sorted by total desc.
        assert [trend.category for trend in trends] == ["Food", "Transport"]
        food = trends[0]
        assert food.total == Decimal("400.00")
        # share of the 700 grand total.
        assert food.share == Decimal("400") / Decimal("700") * Decimal("100")
        # trailing-6-month sparkline Jan..Jun 2026 (Feb 200, Apr 100, Jun 300; rest 0).
        assert food.series == [
            Decimal("0.00"),
            Decimal("200.00"),
            Decimal("0.00"),
            Decimal("100.00"),
            Decimal("0.00"),
            Decimal("300.00"),
        ]
        # delta vs previous Food total 200: (400-200)/200 = 100%.
        assert food.delta_pct == Decimal("100")

    def test_category_absent_in_previous_has_none_delta(self):
        """
        GIVEN a category present in the current window but absent from the previous
        WHEN the trends are built
        THEN its delta vs the previous window is None (no base to compare against)
        """
        # GIVEN
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 1))
        by_month_category = {"2026-05": {"Shopping": Decimal("500")}}

        # WHEN
        trends = build_category_trends(
            current,
            previous,
            date(2026, 6, 1),
            expense_by_month_category=by_month_category,
        )

        # THEN
        assert len(trends) == 1
        assert trends[0].category == "Shopping"
        assert trends[0].delta_pct is None

    def test_empty_window_yields_no_trends(self):
        """
        GIVEN no expense data anywhere
        WHEN the trends are built
        THEN the list is empty
        """
        # GIVEN
        current, previous = resolve_windows(RANGE_3M, date(2026, 6, 1))

        # WHEN
        trends = build_category_trends(current, previous, date(2026, 6, 1), expense_by_month_category={})

        # THEN
        assert trends == []


class TestBuildFxSummary:
    """The FX summary averages captured rates, sums USD invoiced, and degrades gracefully (ADR-167)."""

    def test_avg_mep_usd_invoiced_and_rate_series(self):
        """
        GIVEN per-month average captured rates in two of three months and USD invoiced
        WHEN the FX summary is built
        THEN avg_mep is the mean of the present months, usd_invoiced sums the window,
             and the rate series has a point per month (None where no snapshot)
        """
        # GIVEN
        current, _ = resolve_windows(RANGE_3M, date(2026, 6, 1))

        # WHEN
        summary = build_fx_summary(
            current,
            avg_rate_by_month={"2026-04": Decimal("1000"), "2026-06": Decimal("1200")},
            usd_invoiced_by_month={"2026-04": Decimal("500"), "2026-06": Decimal("300")},
        )

        # THEN — mean of the two present rates.
        assert summary.avg_mep == Decimal("1100.000000")
        assert summary.usd_invoiced == Decimal("800.00")
        assert [point.month for point in summary.rate_series] == ["2026-04", "2026-05", "2026-06"]
        assert summary.rate_series[0].rate == Decimal("1000.000000")
        assert summary.rate_series[1].rate is None

    def test_no_snapshots_degrades_to_nulls_and_zero(self):
        """
        GIVEN a window with no captured rates and no USD invoiced
        WHEN the FX summary is built
        THEN avg_mep is None, usd_invoiced is 0 and every rate-series point is None
        """
        # GIVEN
        current, _ = resolve_windows(RANGE_3M, date(2026, 6, 1))

        # WHEN
        summary = build_fx_summary(current, avg_rate_by_month={}, usd_invoiced_by_month={})

        # THEN
        assert summary.avg_mep is None
        assert summary.usd_invoiced == Decimal("0.00")
        assert all(point.rate is None for point in summary.rate_series)


class TestBuildOverview:
    """The full assembly stitches the range, currency and every panel together (ADR-167)."""

    def test_assembles_all_panels_and_echoes_range_and_currency(self):
        """
        GIVEN raw aggregates for a 6M USD window
        WHEN the overview is assembled
        THEN it echoes the range and currency, carries the KPI/cashflow/category/FX
             panels and the unconverted count
        """
        # GIVEN
        income = {"2026-06": Decimal("1000")}
        expenses = {"2026-06": Decimal("400")}
        by_cat = {"2026-06": {"Food": Decimal("400")}}

        # WHEN
        overview = build_overview(
            RANGE_6M,
            date(2026, 6, 1),
            "USD",
            income_by_month=income,
            expenses_by_month=expenses,
            expense_by_month_category=by_cat,
            avg_rate_by_month={"2026-06": Decimal("1000")},
            usd_invoiced_by_month={"2026-06": Decimal("1000")},
            unconverted=3,
        )

        # THEN
        assert overview.range == RANGE_6M
        assert overview.currency == "USD"
        assert overview.unconverted == 3
        assert len(overview.cash_flow) == 6
        assert overview.kpis.current.income == Decimal("1000.00")
        assert overview.category_trends[0].category == "Food"
        assert overview.fx_summary.usd_invoiced == Decimal("1000.00")
