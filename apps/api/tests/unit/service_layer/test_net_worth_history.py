"""Unit tests for the pure net-worth history assembly (ADR-164).

These exercise the cumulative month-END roll-up with no I/O: opening balances +
per-month signed flow accumulated per currency, the oldest-first window, months
with no movement carrying the prior cumulative, per-currency subtotals staying
independent, the empty series, and the months clamp.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.net_worth_history import (
    DEFAULT_MONTHS,
    MAX_MONTHS,
    MIN_MONTHS,
    build_net_worth_history,
    clamp_months,
    history_window,
)

_REFERENCE = date(2026, 6, 15)


class TestClampMonths:
    """``clamp_months`` bounds the window to the supported range (ADR-164)."""

    async def test_default_and_in_range_pass_through(self):
        """
        GIVEN an in-range request
        WHEN it is clamped
        THEN it passes through unchanged
        """
        # WHEN / THEN
        assert clamp_months(DEFAULT_MONTHS) == DEFAULT_MONTHS
        assert clamp_months(3) == 3

    async def test_below_min_clamps_up_and_above_max_clamps_down(self):
        """
        GIVEN requests below the minimum and above the maximum
        WHEN they are clamped
        THEN they are bounded to MIN_MONTHS and MAX_MONTHS
        """
        # WHEN / THEN
        assert clamp_months(0) == MIN_MONTHS
        assert clamp_months(-5) == MIN_MONTHS
        assert clamp_months(MAX_MONTHS + 100) == MAX_MONTHS


class TestHistoryWindow:
    """``history_window`` returns the oldest-first month starts ending at the reference."""

    async def test_three_month_window_is_oldest_first(self):
        """
        GIVEN a 3-month window ending at June 2026
        WHEN the window is built
        THEN it is [April, May, June], oldest-first, each the first of the month
        """
        # WHEN
        window = history_window(_REFERENCE, 3)

        # THEN
        assert window == [date(2026, 4, 1), date(2026, 5, 1), date(2026, 6, 1)]

    async def test_window_spans_a_year_boundary(self):
        """
        GIVEN a 3-month window ending at January 2026
        WHEN the window is built
        THEN it wraps back across the year boundary into 2025
        """
        # WHEN
        window = history_window(date(2026, 1, 10), 3)

        # THEN
        assert window == [date(2025, 11, 1), date(2025, 12, 1), date(2026, 1, 1)]


class TestBuildNetWorthHistory:
    """``build_net_worth_history`` accumulates opening + flow into month-END subtotals."""

    async def test_cumulative_across_a_month_boundary_per_currency(self):
        """
        GIVEN an ARS opening balance and ARS flow in two of three months, plus USD flow
        WHEN the 3-month history is built
        THEN each month carries the running cumulative and the currencies stay independent
        """
        # GIVEN — ARS opens at 10000; +5000 in April, -2000 in June; USD +50 in May.
        opening = {Currency.ARS: Decimal("10000")}
        flow = {
            Currency.ARS: {"2026-04": Decimal("5000"), "2026-06": Decimal("-2000")},
            Currency.USD: {"2026-05": Decimal("50")},
        }

        # WHEN
        history = build_net_worth_history(
            _REFERENCE,
            3,
            opening_by_currency=opening,
            monthly_flow_by_currency=flow,
        )

        # THEN — oldest-first, cumulative ARS and independent USD subtotals.
        points = {point.month: point for point in history.months}
        assert [point.month for point in history.months] == ["2026-04", "2026-05", "2026-06"]
        assert points["2026-04"].ars_total == Decimal("15000")  # 10000 + 5000
        assert points["2026-05"].ars_total == Decimal("15000")  # no ARS flow in May
        assert points["2026-06"].ars_total == Decimal("13000")  # 15000 - 2000
        # USD accumulates on its own axis, unaffected by ARS.
        assert points["2026-04"].usd_total == Decimal("0")
        assert points["2026-05"].usd_total == Decimal("50")
        assert points["2026-06"].usd_total == Decimal("50")

    async def test_flow_folded_into_first_month_lands_in_opening_cumulative(self):
        """
        GIVEN flow the adapter folded into the window's first-month key (pre-window movement)
        WHEN the history is built
        THEN the first month's cumulative already reflects that carried-in balance
        """
        # GIVEN — no opening balance, but 8000 ARS was carried into the first month.
        flow = {Currency.ARS: {"2026-04": Decimal("8000")}}

        # WHEN
        history = build_net_worth_history(
            _REFERENCE,
            3,
            opening_by_currency={},
            monthly_flow_by_currency=flow,
        )

        # THEN — the first month starts from the carried-in balance and holds it forward.
        assert history.months[0].ars_total == Decimal("8000")
        assert history.months[-1].ars_total == Decimal("8000")

    async def test_empty_history_is_all_zero(self):
        """
        GIVEN no accounts, no opening balances and no flow
        WHEN a 2-month history is built
        THEN every month is present with zero subtotals (never an empty series)
        """
        # WHEN
        history = build_net_worth_history(
            _REFERENCE,
            2,
            opening_by_currency={},
            monthly_flow_by_currency={},
        )

        # THEN
        assert [point.month for point in history.months] == ["2026-05", "2026-06"]
        assert all(point.ars_total == Decimal("0") and point.usd_total == Decimal("0") for point in history.months)
