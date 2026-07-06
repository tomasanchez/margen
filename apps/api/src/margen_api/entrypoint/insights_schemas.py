"""Boundary schemas for the monthly insights contract (ADR-060, ADR-061, ADR-030).

These Pydantic models translate the query-side :class:`MonthlyInsights` read model
into the camelCase JSON the Home Insights card expects -- *structured facts*, never
pre-formatted prose. The frontend composes calm sentences from these facts using
its own formatters and the display-currency preference (ADR-016/ADR-056). Money is
serialized as ``Decimal`` exactly as the transactions endpoint does (ADR-025), so
the frontend parses one consistent number style. Each optional member serializes as
``null`` when its underlying data does not exist (ADR-060).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import Field

from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.insights_read_models import (
    LatestUsdInvoice,
    MonthlyInsights,
    RecurringExpenses,
    Savings,
    TopCategoryMover,
    UpcomingCardDue,
)


class TopCategoryMoverResponse(CamelCaseModel):
    """The expense category that grew the most versus the prior month (ADR-060)."""

    category: str = Field(description="Category label; 'Uncategorized' buckets rows with no category.")
    delta_pct: Decimal = Field(description="Positive percent change vs the same category in the prior month.")

    @classmethod
    def from_read_model(cls, model: TopCategoryMover) -> TopCategoryMoverResponse:
        """Build the response fact from a top-mover read model."""
        return cls(category=model.category, delta_pct=model.delta_pct)


class RecurringExpensesResponse(CamelCaseModel):
    """The recurring-expense footprint for the month (ADR-060)."""

    count: int = Field(description="Number of recurring expense transactions in the month.")
    total: Decimal = Field(description="Total ARS-equivalent amount of the recurring expenses.")

    @classmethod
    def from_read_model(cls, model: RecurringExpenses) -> RecurringExpensesResponse:
        """Build the response fact from a recurring-expenses read model."""
        return cls(count=model.count, total=model.total)


class SavingsResponse(CamelCaseModel):
    """Savings for the month -- actual for a past month, projected for the current (ADR-060)."""

    amount: Decimal = Field(description="ARS-equivalent savings; projected to month-end for the current month.")
    is_projected: bool = Field(description="Whether 'amount' is a month-end projection (true for the current month).")
    elapsed_fraction: Decimal = Field(description="Fraction of the month elapsed at the reference date, in (0, 1].")

    @classmethod
    def from_read_model(cls, model: Savings) -> SavingsResponse:
        """Build the response fact from a savings read model."""
        return cls(
            amount=model.amount,
            is_projected=model.is_projected,
            elapsed_fraction=model.elapsed_fraction,
        )


class LatestUsdInvoiceResponse(CamelCaseModel):
    """The latest USD transaction carrying an applied rate this month (ADR-060)."""

    usd: Decimal = Field(description="Original USD amount.")
    rate: Decimal = Field(description="Applied FX rate.")
    rate_type: str = Field(description="The FX rate source label (e.g. 'MEP', 'manual').")
    occurred_on: date = Field(description="The transaction date.")

    @classmethod
    def from_read_model(cls, model: LatestUsdInvoice) -> LatestUsdInvoiceResponse:
        """Build the response fact from a latest-USD-invoice read model."""
        return cls(
            usd=model.usd,
            rate=model.rate,
            rate_type=model.rate_type,
            occurred_on=model.occurred_on,
        )


class UpcomingCardDueResponse(CamelCaseModel):
    """A near-term credit-card payment due date and its native per-currency total (ADR-089)."""

    due_date: date = Field(description="The upcoming statement pay date the charges fall on.")
    ars: Decimal = Field(description="Total ARS card charges due on that date; 0 when none.")
    usd: Decimal = Field(description="Total USD card charges due on that date; 0 when none.")

    @classmethod
    def from_read_model(cls, model: UpcomingCardDue) -> UpcomingCardDueResponse:
        """Build the response fact from an upcoming-card-due read model."""
        return cls(due_date=model.due_date, ars=model.ars, usd=model.usd)


class MonthlyInsightsResponse(CamelCaseModel):
    """The Home Insights card facts for the requested month (ADR-060, ADR-061)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    top_category_mover: TopCategoryMoverResponse | None = Field(
        default=None,
        description="The biggest positive expense mover vs the prior month; null when none increased.",
    )
    recurring: RecurringExpensesResponse | None = Field(
        default=None,
        description="Count and total of recurring expenses; null when there are none.",
    )
    savings: SavingsResponse = Field(description="Actual or projected savings for the month.")
    latest_usd_invoice: LatestUsdInvoiceResponse | None = Field(
        default=None,
        description="The latest USD transaction with an applied rate; null when the month has none.",
    )
    upcoming_card_due: list[UpcomingCardDueResponse] | None = Field(
        default=None,
        description="Card payments falling due within the next few days, one per date ascending; null when none.",
    )

    @classmethod
    def from_read_model(cls, model: MonthlyInsights) -> MonthlyInsightsResponse:
        """Build the response from a monthly insights read model (ADR-030)."""
        mover = model.top_category_mover
        recurring = model.recurring
        latest = model.latest_usd_invoice
        dues = model.upcoming_card_due
        return cls(
            month=model.month,
            top_category_mover=TopCategoryMoverResponse.from_read_model(mover) if mover is not None else None,
            recurring=RecurringExpensesResponse.from_read_model(recurring) if recurring is not None else None,
            savings=SavingsResponse.from_read_model(model.savings),
            latest_usd_invoice=LatestUsdInvoiceResponse.from_read_model(latest) if latest is not None else None,
            upcoming_card_due=[UpcomingCardDueResponse.from_read_model(due) for due in dues]
            if dues is not None
            else None,
        )
