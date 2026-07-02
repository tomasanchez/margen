"""Pure assembly of the range-based Reports overview (ADR-167, ADR-168, ADR-169).

The SQLAlchemy adapter runs the per-month currency-aware aggregations — income,
expenses, per-category net spend, and the captured-FX facts — and hands the raw
figures to these pure, I/O-free functions, which:

* resolve a range preset (``3M`` / ``6M`` / ``12M`` / ``YTD``) into the current
  month-window ending at the current month AND the immediately-preceding window of
  equal length (``YTD``'s previous is the same span in the prior year, ADR-169);
* compute the KPI strip (income, expenses, net saved, savings rate) for the current
  window plus the previous window's figures for the "vs previous" deltas (ADR-167);
* build the oldest-first per-month cash-flow series over the current window;
* build the per-category trends (total, share of expenses, a trailing-6-month
  sparkline series and the delta vs the previous window's category total); and
* build the FX summary (average captured MEP rate, USD invoiced, per-month rate
  series).

All money is denominated in the requested currency by the adapter (ADR-168): it
sums the authoritative ``amount`` for ARS and the materialized ``usd_amount``
snapshot for USD, preserving the budgets USD path's null-snapshot exclusion and
surfacing the excluded rows as ``unconverted`` (ADR-152). Keeping the windowing and
assembly here keeps SQLAlchemy in the adapter (AGENTS.md). Money is
:class:`~decimal.Decimal` throughout (ADR-025).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

from margen_api.service_layer.reports_overview_read_models import (
    CashFlowPoint,
    CategoryTrend,
    FxSummary,
    RateSeriesPoint,
    ReportsKpi,
    ReportsKpis,
    ReportsOverview,
)


class ReportsRange(StrEnum):
    """The supported Reports range presets (ADR-167).

    ``YTD`` is year-to-date (January..current month); the numeric presets are
    trailing month windows ending at the current month. Used as the boundary query
    enum so an out-of-set range is rejected with ``422`` at validation.
    """

    THREE_MONTHS = "3M"
    SIX_MONTHS = "6M"
    TWELVE_MONTHS = "12M"
    YEAR_TO_DATE = "YTD"


# String aliases for the presets (the read models and pure math key off the raw token).
RANGE_3M = ReportsRange.THREE_MONTHS.value
RANGE_6M = ReportsRange.SIX_MONTHS.value
RANGE_12M = ReportsRange.TWELVE_MONTHS.value
RANGE_YTD = ReportsRange.YEAR_TO_DATE.value
RANGES = (RANGE_3M, RANGE_6M, RANGE_12M, RANGE_YTD)


class UnsupportedReportsRangeError(ValueError):
    """Raised when a range token is not one of the supported presets (ADR-167).

    A defensive guard: the boundary enum rejects an out-of-set range with ``422``
    before the reader runs, so this only fires when the pure resolver is called
    directly with a bad token.
    """

    def __init__(self, range_key: str) -> None:
        self.range_key = range_key
        super().__init__(f"unsupported reports range: {range_key!r}; expected one of {RANGES}")


# Fixed month counts for the trailing presets.
_PRESET_MONTHS: dict[str, int] = {RANGE_3M: 3, RANGE_6M: 6, RANGE_12M: 12}

# The category sparkline is always the trailing 6 months of the category's monthly
# totals (ADR-167), regardless of the selected range length.
SPARKLINE_MONTHS = 6

_ZERO = Decimal(0)
_HUNDRED = Decimal(100)
_CENTS = Decimal("0.01")
# Captured FX rates are quantized to 6 decimals to match the stored precision
# (``fx_rate`` is ``NUMERIC(18, 6)``); an averaged rate never widens beyond that.
_RATE_QUANTUM = Decimal("0.000001")


def month_key(value: date) -> str:
    """Render a calendar month as ``YYYY-MM`` (the API's month identity)."""
    return f"{value.year:04d}-{value.month:02d}"


def add_months(value: date, delta: int) -> date:
    """Return the first day of the month ``delta`` calendar months from ``value``.

    Args:
        value: Any date; only its year and month matter.
        delta: Signed number of months to add (may be negative).

    Returns:
        The first day of the resulting month.
    """
    index = value.year * 12 + (value.month - 1) + delta
    year, month = divmod(index, 12)
    return date(year, month + 1, 1)


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def _rate(value: Decimal) -> Decimal:
    """Round an averaged FX rate to the stored 6-decimal precision (ADR-148)."""
    return value.quantize(_RATE_QUANTUM, rounding=ROUND_HALF_UP)


def _window(first_month: date, months: int) -> list[date]:
    """Return the first days of ``months`` months ending at ``first_month``, oldest-first."""
    return [add_months(first_month, offset) for offset in range(-(months - 1), 1)]


def resolve_windows(range_key: str, reference: date) -> tuple[list[date], list[date]]:
    """Resolve a range preset into the current and previous month windows (ADR-169).

    Both windows are lists of month-start dates, oldest-first. The current window
    ends at ``reference``'s month; the previous window is the immediately-preceding
    window of EQUAL length so the frontend can show "vs previous" deltas.

    * ``3M`` / ``6M`` / ``12M`` — the current window is the trailing N months
      ending at the current month; the previous is the N months immediately before
      it.
    * ``YTD`` — the current window is January through the current month of this
      year; the previous is the SAME span (same number of months) in the prior
      year (Jan..same-month of last year), so a partial-year comparison lines up
      month-for-month across the year boundary.

    Args:
        range_key: One of ``3M``, ``6M``, ``12M``, ``YTD``.
        reference: The reference date (server "today"); only its year/month matter.

    Returns:
        A ``(current_window, previous_window)`` pair of oldest-first month-start
        date lists, each of equal length.

    Raises:
        UnsupportedReportsRangeError: When ``range_key`` is not a supported preset.
    """
    if range_key not in RANGES:
        raise UnsupportedReportsRangeError(range_key)
    current_month = date(reference.year, reference.month, 1)
    if range_key == RANGE_YTD:
        months = reference.month  # Jan..current => reference.month calendar months.
        current = _window(current_month, months)
        prior_end = date(reference.year - 1, reference.month, 1)
        previous = _window(prior_end, months)
        return current, previous
    months = _PRESET_MONTHS[range_key]
    current = _window(current_month, months)
    previous = _window(add_months(current_month, -months), months)
    return current, previous


def _sum(window: list[date], totals_by_month: Mapping[str, Decimal]) -> Decimal:
    """Sum a per-month total map over a window, treating missing months as zero."""
    return sum((totals_by_month.get(month_key(month), _ZERO) for month in window), _ZERO)


def _savings_rate(income: Decimal, net_saved: Decimal) -> Decimal:
    """Return ``net_saved / income`` as a percentage, guarding a zero/negative income base.

    The savings rate is undefined without positive income, so a non-positive income
    base yields ``0`` rather than a divide-by-zero (ADR-167).
    """
    if income <= _ZERO:
        return _ZERO
    return net_saved / income * _HUNDRED


def _kpi(income: Decimal, expenses: Decimal) -> ReportsKpi:
    """Build one window's KPI set from its income and expense totals."""
    net_saved = income - expenses
    return ReportsKpi(
        income=_money(income),
        expenses=_money(expenses),
        net_saved=_money(net_saved),
        savings_rate=_savings_rate(income, net_saved),
    )


def build_kpis(
    current_window: list[date],
    previous_window: list[date],
    *,
    income_by_month: Mapping[str, Decimal],
    expenses_by_month: Mapping[str, Decimal],
) -> ReportsKpis:
    """Build the KPI strip for the current window with the previous window for deltas (ADR-167).

    Income is the inflow kinds (income + invoice; a reimbursement is never income,
    ADR-158) and expenses is the expense kind, both already denominated in the
    requested currency by the adapter (ADR-168). Net saved is ``income - expenses``
    and the savings rate is ``net_saved / income`` (guarded, ADR-167). Both windows
    are computed so the frontend can render every "vs previous" delta.

    Args:
        current_window: The current window's month-start dates, oldest-first.
        previous_window: The previous window's month-start dates, oldest-first.
        income_by_month: Inflow totals keyed by ``YYYY-MM`` across both windows.
        expenses_by_month: Expense totals keyed by ``YYYY-MM`` across both windows.

    Returns:
        The assembled :class:`ReportsKpis` carrying the current and previous KPI sets.
    """
    current = _kpi(_sum(current_window, income_by_month), _sum(current_window, expenses_by_month))
    previous = _kpi(_sum(previous_window, income_by_month), _sum(previous_window, expenses_by_month))
    return ReportsKpis(current=current, previous=previous)


def build_cash_flow(
    current_window: list[date],
    *,
    income_by_month: Mapping[str, Decimal],
    expenses_by_month: Mapping[str, Decimal],
) -> list[CashFlowPoint]:
    """Build the oldest-first per-month cash-flow series over the current window (ADR-167).

    Each point carries the month's income and expenses in the requested currency;
    a month with no movement reads ``0`` for both.

    Args:
        current_window: The current window's month-start dates, oldest-first.
        income_by_month: Inflow totals keyed by ``YYYY-MM``.
        expenses_by_month: Expense totals keyed by ``YYYY-MM``.

    Returns:
        A cash-flow point per month in the current window, oldest-first.
    """
    points: list[CashFlowPoint] = []
    for month in current_window:
        key = month_key(month)
        points.append(
            CashFlowPoint(
                month=key,
                income=_money(income_by_month.get(key, _ZERO)),
                expenses=_money(expenses_by_month.get(key, _ZERO)),
            )
        )
    return points


def _category_total(
    window: list[date], category: str, by_month_category: Mapping[str, Mapping[str, Decimal]]
) -> Decimal:
    """Sum one category's per-month totals across a window (missing months are zero)."""
    return sum((by_month_category.get(month_key(month), {}).get(category, _ZERO) for month in window), _ZERO)


def _delta_pct(current: Decimal, previous: Decimal) -> Decimal | None:
    """Return the percent change from ``previous`` to ``current``, or ``None``.

    ``None`` when the previous total is zero — there is no meaningful base to
    compare against (a category present only in the current window, ADR-167).
    """
    if previous == _ZERO:
        return None
    return (current - previous) / previous * _HUNDRED


def build_category_trends(
    current_window: list[date],
    previous_window: list[date],
    reference: date,
    *,
    expense_by_month_category: Mapping[str, Mapping[str, Decimal]],
) -> list[CategoryTrend]:
    """Build the per-expense-category trends over the current window (ADR-167).

    For every category that has spend in the current window: its ``total`` in the
    requested currency, its ``share`` of the window's total expenses, a
    trailing-6-month sparkline ``series`` (that category's monthly totals over the 6
    months ending at ``reference``, oldest-first), and the ``delta_pct`` versus the
    same category's total over the PREVIOUS window. Sorted by total descending
    (category name as a stable tiebreak). A category present in the current window
    but absent from the previous one has a ``None`` delta (no base, ADR-167).

    Args:
        current_window: The current window's month-start dates, oldest-first.
        previous_window: The previous window's month-start dates, oldest-first.
        reference: The reference date; the sparkline is the 6 months ending here.
        expense_by_month_category: Net expense totals keyed by ``YYYY-MM`` then by
            category, spanning at least the previous window through the current one
            and the trailing-6-month sparkline range.

    Returns:
        The category trends, sorted by current-window total descending.
    """
    current_month = date(reference.year, reference.month, 1)
    sparkline_window = _window(current_month, SPARKLINE_MONTHS)
    categories = {
        category for month in current_window for category in expense_by_month_category.get(month_key(month), {})
    }
    totals = {category: _category_total(current_window, category, expense_by_month_category) for category in categories}
    grand_total = sum(totals.values(), _ZERO)
    trends: list[CategoryTrend] = []
    for category in categories:
        total = totals[category]
        previous_total = _category_total(previous_window, category, expense_by_month_category)
        series = [
            _money(expense_by_month_category.get(month_key(month), {}).get(category, _ZERO))
            for month in sparkline_window
        ]
        trends.append(
            CategoryTrend(
                category=category,
                total=_money(total),
                share=(total / grand_total * _HUNDRED) if grand_total != _ZERO else _ZERO,
                series=series,
                delta_pct=_delta_pct(total, previous_total),
            )
        )
    trends.sort(key=lambda trend: (-trend.total, trend.category))
    return trends


def build_fx_summary(
    current_window: list[date],
    *,
    avg_rate_by_month: Mapping[str, Decimal],
    usd_invoiced_by_month: Mapping[str, Decimal],
) -> FxSummary:
    """Build the FX & purchasing-power summary over the current window (ADR-167).

    * ``avg_mep`` — the mean of the per-month average captured ``fx_rate`` across the
      window's months that HAVE a snapshotted rate; ``None`` when no month in the
      window carries a captured rate (the panel degrades gracefully, ADR-167).
    * ``usd_invoiced`` — the SUM of USD-native invoiced/income ``usd_amount`` in the
      window; ``0`` when none.
    * ``rate_series`` — a per-month point for every month in the window whose value
      is the month's average captured rate, or ``None`` when that month has no
      snapshot (an empty/None-studded sparkline degrades gracefully).

    Args:
        current_window: The current window's month-start dates, oldest-first.
        avg_rate_by_month: The per-month average captured ``fx_rate`` keyed by
            ``YYYY-MM``; months without any snapshot are absent.
        usd_invoiced_by_month: The per-month SUM of USD-native invoiced/income
            ``usd_amount`` keyed by ``YYYY-MM``; months without any are absent.

    Returns:
        The assembled :class:`FxSummary`.
    """
    rate_series: list[RateSeriesPoint] = []
    captured: list[Decimal] = []
    for month in current_window:
        key = month_key(month)
        rate = avg_rate_by_month.get(key)
        rate_series.append(RateSeriesPoint(month=key, rate=_rate(rate) if rate is not None else None))
        if rate is not None:
            captured.append(rate)
    avg_mep = _rate(sum(captured, _ZERO) / len(captured)) if captured else None
    usd_invoiced = _money(_sum(current_window, usd_invoiced_by_month))
    return FxSummary(avg_mep=avg_mep, usd_invoiced=usd_invoiced, rate_series=rate_series)


def build_overview(
    range_key: str,
    reference: date,
    currency: str,
    *,
    income_by_month: Mapping[str, Decimal],
    expenses_by_month: Mapping[str, Decimal],
    expense_by_month_category: Mapping[str, Mapping[str, Decimal]],
    avg_rate_by_month: Mapping[str, Decimal],
    usd_invoiced_by_month: Mapping[str, Decimal],
    unconverted: int,
) -> ReportsOverview:
    """Assemble the full range-based Reports overview from the raw aggregates (ADR-167, ADR-169).

    Args:
        range_key: The resolved range preset (``3M`` / ``6M`` / ``12M`` / ``YTD``).
        reference: The reference date (server "today").
        currency: The requested denomination currency (``ARS`` / ``USD``), echoed back.
        income_by_month: Inflow totals keyed by ``YYYY-MM`` across both windows.
        expenses_by_month: Expense totals keyed by ``YYYY-MM`` across both windows.
        expense_by_month_category: Net expense totals keyed by ``YYYY-MM`` then
            category, spanning both windows and the trailing-6-month sparkline range.
        avg_rate_by_month: Per-month average captured ``fx_rate`` keyed by ``YYYY-MM``.
        usd_invoiced_by_month: Per-month USD-native invoiced/income ``usd_amount``
            keyed by ``YYYY-MM``.
        unconverted: Count of window rows excluded from the USD denomination for
            lacking a snapshot (always ``0`` on the ARS path, ADR-152).

    Returns:
        The assembled :class:`ReportsOverview`.
    """
    current_window, previous_window = resolve_windows(range_key, reference)
    return ReportsOverview(
        range=range_key,
        currency=currency,
        kpis=build_kpis(
            current_window,
            previous_window,
            income_by_month=income_by_month,
            expenses_by_month=expenses_by_month,
        ),
        cash_flow=build_cash_flow(
            current_window,
            income_by_month=income_by_month,
            expenses_by_month=expenses_by_month,
        ),
        category_trends=build_category_trends(
            current_window,
            previous_window,
            reference,
            expense_by_month_category=expense_by_month_category,
        ),
        fx_summary=build_fx_summary(
            current_window,
            avg_rate_by_month=avg_rate_by_month,
            usd_invoiced_by_month=usd_invoiced_by_month,
        ),
        unconverted=unconverted,
    )
