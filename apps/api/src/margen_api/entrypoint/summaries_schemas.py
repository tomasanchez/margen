"""Boundary schemas for the monthly summaries contract (ADR-042, ADR-030).

These Pydantic models translate the query-side :class:`MonthlySummary` read model
into the camelCase JSON the Home dashboard expects (ADR-043) — a ``trend`` series
and a ``categories`` breakdown wrapped in the ``ResponseModel`` envelope. Money is
serialized as ``Decimal`` exactly as the transactions endpoint does (ADR-025), so
the frontend parses one consistent number style.
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field

from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.summary_read_models import (
    CategorySummary,
    MonthlySummary,
    TrendPoint,
)


class TrendPointResponse(CamelCaseModel):
    """One month of expense total in the 6-month trend (ADR-042)."""

    month: str = Field(description="Calendar month as 'YYYY-MM'.")
    expenses: Decimal = Field(description="Total ARS-equivalent expenses for the month; 0 when none.")
    current: bool = Field(description="Whether this is the requested month (the last trend point).")

    @classmethod
    def from_read_model(cls, model: TrendPoint) -> TrendPointResponse:
        """Build the response point from a trend read model."""
        return cls(month=model.month, expenses=model.expenses, current=model.current)


class CategorySummaryResponse(CamelCaseModel):
    """One category's spend for the requested month (ADR-042)."""

    category: str = Field(description="Category label; 'Uncategorized' buckets rows with no category.")
    amount: Decimal = Field(description="Total ARS-equivalent expenses for the category.")
    share: Decimal = Field(description="Percentage (0-100) of the month's total expenses.")
    delta_pct: Decimal | None = Field(
        default=None,
        description="Percent change vs the same category in the prior month; null when prior is 0 or absent.",
    )

    @classmethod
    def from_read_model(cls, model: CategorySummary) -> CategorySummaryResponse:
        """Build the response summary from a category read model."""
        return cls(
            category=model.category,
            amount=model.amount,
            share=model.share,
            delta_pct=model.delta_pct,
        )


class MonthlySummaryResponse(CamelCaseModel):
    """The Home dashboard summary for the requested month (ADR-042)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    trend: list[TrendPointResponse] = Field(description="The 6 months ending at 'month', oldest-first.")
    categories: list[CategorySummaryResponse] = Field(
        description="The month's category breakdown, sorted by amount descending.",
    )

    @classmethod
    def from_read_model(cls, model: MonthlySummary) -> MonthlySummaryResponse:
        """Build the response from a monthly summary read model (ADR-030)."""
        return cls(
            month=model.month,
            trend=[TrendPointResponse.from_read_model(point) for point in model.trend],
            categories=[CategorySummaryResponse.from_read_model(category) for category in model.categories],
        )
