"""Read models for the range-based Reports overview (ADR-167, ADR-169).

Purpose-built, immutable DTOs for the redesigned Reports page's single
``GET /reports/overview`` response — deliberately separate from the write
aggregates so the query side evolves independently (AGENTS.md reader ports + read
models). Money is :class:`~decimal.Decimal` (ADR-025) and every figure is
denominated in the requested currency by the reader (ADR-168); the ``unconverted``
count surfaces the rows a USD denomination excluded for lacking a snapshot so a USD
total is never silently understated (ADR-152).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class ReportsKpi:
    """One window's headline KPIs, all in the requested currency (ADR-167).

    Attributes:
        income: Inflow (income + invoice) total over the window.
        expenses: Expense total over the window.
        net_saved: ``income - expenses`` (may be negative).
        savings_rate: ``net_saved / income * 100`` as a percentage; ``0`` when
            income is non-positive (guarded, ADR-167).
    """

    income: Decimal
    expenses: Decimal
    net_saved: Decimal
    savings_rate: Decimal


@dataclass(frozen=True, slots=True)
class ReportsKpis:
    """The KPI strip: the current window plus the previous window for deltas (ADR-167).

    Attributes:
        current: The selected window's KPIs.
        previous: The immediately-preceding equal-length window's KPIs, so the
            frontend can render every "vs previous" delta (ADR-169).
    """

    current: ReportsKpi
    previous: ReportsKpi


@dataclass(frozen=True, slots=True)
class CashFlowPoint:
    """One month's income vs expenses in the requested currency (ADR-167).

    Attributes:
        month: Calendar month as ``YYYY-MM``.
        income: Inflow total for the month; ``0`` when none.
        expenses: Expense total for the month; ``0`` when none.
    """

    month: str
    income: Decimal
    expenses: Decimal


@dataclass(frozen=True, slots=True)
class CategoryTrend:
    """One expense category's trend over the current window (ADR-167).

    Attributes:
        category: The category label (``Uncategorized`` for null-category spend).
        total: The category's total spend over the current window.
        share: The category's share of the window's total expenses as a percentage;
            ``0`` when the window has no expenses.
        series: The category's monthly totals over the trailing 6 months ending at
            the reference month, oldest-first — a sparkline (always 6 entries).
        delta_pct: Percent change of ``total`` versus the same category's total over
            the PREVIOUS window; ``None`` when the previous total is zero (no base —
            e.g. a category present only in the current window, ADR-167).
    """

    category: str
    total: Decimal
    share: Decimal
    series: list[Decimal]
    delta_pct: Decimal | None


@dataclass(frozen=True, slots=True)
class RateSeriesPoint:
    """One month's average captured FX rate for the FX sparkline (ADR-167).

    Attributes:
        month: Calendar month as ``YYYY-MM``.
        rate: The month's average captured ``fx_rate``, or ``None`` when the month
            has no snapshotted row (the sparkline degrades gracefully).
    """

    month: str
    rate: Decimal | None


@dataclass(frozen=True, slots=True)
class FxSummary:
    """The FX & purchasing-power summary over the current window (ADR-167).

    Attributes:
        avg_mep: The mean of the per-month average captured rates across the
            window's snapshotted months, or ``None`` when no month has a captured
            rate (empty/degraded panel).
        usd_invoiced: SUM of USD-native invoiced/income ``usd_amount`` in the window;
            ``0`` when none.
        rate_series: A per-month point (oldest-first) carrying the month's average
            captured rate, or ``None`` for months without a snapshot.
    """

    avg_mep: Decimal | None
    usd_invoiced: Decimal
    rate_series: list[RateSeriesPoint]


@dataclass(frozen=True, slots=True)
class ReportsOverview:
    """The full range-based Reports overview payload (ADR-167, ADR-169).

    Attributes:
        range: The resolved range preset (``3M`` / ``6M`` / ``12M`` / ``YTD``).
        currency: The denomination currency (``ARS`` / ``USD``), echoed back.
        kpis: The KPI strip (current + previous windows).
        cash_flow: The oldest-first per-month income/expense series over the current
            window.
        category_trends: The per-category trends, sorted by current-window total
            descending.
        fx_summary: The FX & purchasing-power summary.
        unconverted: Count of window rows excluded from a USD denomination for
            lacking a snapshot; always ``0`` on the ARS path (ADR-152).
    """

    range: str
    currency: str
    kpis: ReportsKpis
    cash_flow: list[CashFlowPoint]
    category_trends: list[CategoryTrend]
    fx_summary: FxSummary
    unconverted: int
