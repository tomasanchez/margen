"""Boundary schemas for the reports contract (ADR-163, ADR-164, ADR-167, ADR-030).

Translates the query-side read models into the camelCase JSON the Reports page
expects (ADR-030), wrapped in the ``ResponseModel`` envelope:

* :class:`NetWorthHistoryResponse` — the retained net-worth series, native
  per-currency subtotals with no server-side FX (ADR-164).
* :class:`ReportsOverviewResponse` — the redesigned range-based overview (KPI strip,
  cash-flow series, category trends and FX summary), every figure denominated in the
  requested currency (ADR-167, ADR-168).

Money is serialized as ``Decimal`` exactly as the rest of the app does (ADR-025).
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field

from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.reports_overview_read_models import (
    CashFlowPoint,
    CategoryTrend,
    FxSummary,
    RateSeriesPoint,
    ReportsKpi,
    ReportsKpis,
    ReportsOverview,
)
from margen_api.service_layer.reports_read_models import NetWorthHistory, NetWorthHistoryPoint


class NetWorthHistoryPointResponse(CamelCaseModel):
    """One month's cumulative month-END native net balance per currency (ADR-164)."""

    month: str = Field(description="Calendar month as 'YYYY-MM'.")
    ars_total: Decimal = Field(description="Cumulative native ARS balance at month-end; 0 when none.")
    usd_total: Decimal = Field(description="Cumulative native USD balance at month-end; 0 when none.")

    @classmethod
    def from_read_model(cls, model: NetWorthHistoryPoint) -> NetWorthHistoryPointResponse:
        """Build the response point from a history read model."""
        return cls(month=model.month, ars_total=model.ars_total, usd_total=model.usd_total)


class NetWorthHistoryResponse(CamelCaseModel):
    """The net-worth history series for the Reports page (ADR-164)."""

    months: list[NetWorthHistoryPointResponse] = Field(
        description="Per-month native subtotals, oldest-first, ending at the current month.",
    )

    @classmethod
    def from_read_model(cls, model: NetWorthHistory) -> NetWorthHistoryResponse:
        """Build the response from a net-worth history read model (ADR-030)."""
        return cls(months=[NetWorthHistoryPointResponse.from_read_model(point) for point in model.months])


class ReportsKpiResponse(CamelCaseModel):
    """One window's headline KPIs in the requested currency (ADR-167)."""

    income: Decimal = Field(description="Inflow (income + invoice) total over the window.")
    expenses: Decimal = Field(description="Expense total over the window.")
    net_saved: Decimal = Field(description="income - expenses (may be negative).")
    savings_rate: Decimal = Field(description="net_saved / income as a percentage; 0 when income is non-positive.")

    @classmethod
    def from_read_model(cls, model: ReportsKpi) -> ReportsKpiResponse:
        """Build the KPI response from a read model."""
        return cls(
            income=model.income,
            expenses=model.expenses,
            net_saved=model.net_saved,
            savings_rate=model.savings_rate,
        )


class ReportsKpisResponse(CamelCaseModel):
    """The KPI strip: current window plus previous window for deltas (ADR-167, ADR-169)."""

    current: ReportsKpiResponse = Field(description="The selected window's KPIs.")
    previous: ReportsKpiResponse = Field(description="The immediately-preceding equal-length window's KPIs.")

    @classmethod
    def from_read_model(cls, model: ReportsKpis) -> ReportsKpisResponse:
        """Build the KPI-strip response from a read model."""
        return cls(
            current=ReportsKpiResponse.from_read_model(model.current),
            previous=ReportsKpiResponse.from_read_model(model.previous),
        )


class CashFlowPointResponse(CamelCaseModel):
    """One month's income vs expenses in the requested currency (ADR-167)."""

    month: str = Field(description="Calendar month as 'YYYY-MM'.")
    income: Decimal = Field(description="Inflow total for the month; 0 when none.")
    expenses: Decimal = Field(description="Expense total for the month; 0 when none.")

    @classmethod
    def from_read_model(cls, model: CashFlowPoint) -> CashFlowPointResponse:
        """Build the cash-flow point response from a read model."""
        return cls(month=model.month, income=model.income, expenses=model.expenses)


class CategoryTrendResponse(CamelCaseModel):
    """One expense category's trend over the current window (ADR-167)."""

    category: str = Field(description="The category label ('Uncategorized' for null-category spend).")
    total: Decimal = Field(description="The category's total spend over the current window.")
    share: Decimal = Field(description="Share of the window's total expenses as a percentage; 0 when no expenses.")
    series: list[Decimal] = Field(description="Trailing-6-month monthly totals for a sparkline, oldest-first.")
    delta_pct: Decimal | None = Field(
        default=None,
        description="Percent change of total vs the previous window's category total; null when no base.",
    )

    @classmethod
    def from_read_model(cls, model: CategoryTrend) -> CategoryTrendResponse:
        """Build the category-trend response from a read model."""
        return cls(
            category=model.category,
            total=model.total,
            share=model.share,
            series=list(model.series),
            delta_pct=model.delta_pct,
        )


class RateSeriesPointResponse(CamelCaseModel):
    """One month's average captured FX rate for the FX sparkline (ADR-167)."""

    month: str = Field(description="Calendar month as 'YYYY-MM'.")
    rate: Decimal | None = Field(
        default=None,
        description="The month's average captured fx_rate, or null when the month has no snapshot.",
    )

    @classmethod
    def from_read_model(cls, model: RateSeriesPoint) -> RateSeriesPointResponse:
        """Build the rate-series point response from a read model."""
        return cls(month=model.month, rate=model.rate)


class FxSummaryResponse(CamelCaseModel):
    """The FX & purchasing-power summary over the current window (ADR-167)."""

    avg_mep: Decimal | None = Field(
        default=None,
        description="Mean of per-month average captured rates; null when no month has a captured rate.",
    )
    usd_invoiced: Decimal = Field(
        description="SUM of USD-native invoiced/income usd_amount in the window; 0 when none."
    )
    rate_series: list[RateSeriesPointResponse] = Field(
        description="Per-month average captured rate, oldest-first; each rate may be null.",
    )

    @classmethod
    def from_read_model(cls, model: FxSummary) -> FxSummaryResponse:
        """Build the FX-summary response from a read model."""
        return cls(
            avg_mep=model.avg_mep,
            usd_invoiced=model.usd_invoiced,
            rate_series=[RateSeriesPointResponse.from_read_model(point) for point in model.rate_series],
        )


class ReportsOverviewResponse(CamelCaseModel):
    """The full range-based Reports overview payload (ADR-167, ADR-169)."""

    range: str = Field(description="The resolved range preset (3M / 6M / 12M / YTD).")
    currency: str = Field(description="The denomination currency (ARS / USD), echoed back.")
    kpis: ReportsKpisResponse = Field(description="The KPI strip (current + previous windows).")
    cash_flow: list[CashFlowPointResponse] = Field(description="Oldest-first per-month income/expense series.")
    category_trends: list[CategoryTrendResponse] = Field(description="Per-category trends, sorted by total descending.")
    fx_summary: FxSummaryResponse = Field(description="The FX & purchasing-power summary.")
    unconverted: int = Field(
        description="Count of window rows excluded from a USD denomination for lacking a snapshot; 0 on the ARS path.",
    )

    @classmethod
    def from_read_model(cls, model: ReportsOverview) -> ReportsOverviewResponse:
        """Build the overview response from a read model (ADR-030)."""
        return cls(
            range=model.range,
            currency=model.currency,
            kpis=ReportsKpisResponse.from_read_model(model.kpis),
            cash_flow=[CashFlowPointResponse.from_read_model(point) for point in model.cash_flow],
            category_trends=[CategoryTrendResponse.from_read_model(trend) for trend in model.category_trends],
            fx_summary=FxSummaryResponse.from_read_model(model.fx_summary),
            unconverted=model.unconverted,
        )
