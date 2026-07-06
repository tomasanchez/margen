"""Read models for the monthly insights query side (ADR-060, ADR-061).

These are purpose-built, immutable DTOs carrying the *structured facts* behind the
Home Insights card -- never pre-formatted prose. The frontend composes calm
sentences from these facts using its es-AR formatters and the display-currency
preference (ADR-016/ADR-056), so the backend deliberately stays formatting-free.
Money is carried as :class:`~decimal.Decimal` (ADR-025); each optional member is
``None`` when its underlying data does not exist, so the card renders only the
insights that apply (ADR-060).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class TopCategoryMover:
    """The expense category that grew the most versus the prior month (ADR-060).

    Attributes:
        category: Category label (``"Uncategorized"`` buckets null categories).
        delta_pct: Positive percent change versus the same category in the prior
            calendar month; only the largest positive mover is reported.
    """

    category: str
    delta_pct: Decimal


@dataclass(frozen=True, slots=True)
class RecurringExpenses:
    """The recurring-expense footprint for the month (ADR-060).

    Attributes:
        count: Number of expense transactions flagged ``recurring`` in the month.
        total: SUM of their ARS-equivalent ``amount`` (ADR-025).
    """

    count: int
    total: Decimal


@dataclass(frozen=True, slots=True)
class Savings:
    """Savings for the month -- actual for a past month, projected for the current.

    Income (income + invoice kinds) minus expenses. For the current month the
    figure is scaled to month-end by ``1 / elapsed_fraction`` and flagged
    ``is_projected``; for a past month it is the actual with ``elapsed_fraction``
    equal to ``1`` (ADR-060).

    Attributes:
        amount: ARS-equivalent savings; projected for the current month.
        is_projected: Whether ``amount`` is a month-end projection.
        elapsed_fraction: Fraction of the month elapsed at the reference date,
            in ``(0, 1]``; ``1`` for a past month.
    """

    amount: Decimal
    is_projected: bool
    elapsed_fraction: Decimal


@dataclass(frozen=True, slots=True)
class LatestUsdInvoice:
    """The most recent USD transaction carrying an applied rate this month (ADR-060).

    Attributes:
        usd: Original USD amount (``usd_amount``).
        rate: Applied FX rate (``fx_rate``).
        rate_type: The rate source label (``fx_rate_type``).
        occurred_on: The transaction date.
    """

    usd: Decimal
    rate: Decimal
    rate_type: str
    occurred_on: date


@dataclass(frozen=True, slots=True)
class UpcomingCardDue:
    """A near-term credit-card payment due date and its native per-currency total (ADR-089).

    Groups the owner's CARD-account EXPENSE charges dated on a single upcoming
    ``due_date`` -- ``occurred_on`` is the statement pay date (ADR-089), so a charge
    dated today or in the next few days is money about to auto-debit. ARS and USD are
    kept separate as native magnitudes (never summed across currencies) so the client
    converts each at the live rate (ADR-183); a date with only one currency carries ``0``
    for the other.

    Attributes:
        due_date: The upcoming statement pay date the charges fall on.
        ars: SUM of that date's ARS card charges (``amount``); ``0`` when none.
        usd: SUM of that date's USD card charges (``usd_amount``); ``0`` when none.
    """

    due_date: date
    ars: Decimal
    usd: Decimal


@dataclass(frozen=True, slots=True)
class MonthlyInsights:
    """The structured insight facts for the requested month (ADR-060, ADR-061).

    Each member is ``None`` when its underlying data does not exist, except
    ``savings`` which is always present (it may be zero). The frontend renders
    only the insights that apply (ADR-060) and formats the figures itself.

    Attributes:
        month: The requested month as ``YYYY-MM``.
        top_category_mover: The largest positive month-over-month expense mover,
            or ``None`` when there is no prior data or no increase.
        recurring: Count and total of recurring expenses, or ``None`` when none.
        savings: Actual or projected savings for the month.
        latest_usd_invoice: The latest USD transaction with an applied rate, or
            ``None`` when the month has none.
        upcoming_card_due: The owner's card payments falling due within the next few
            days (as-of "today", independent of the requested month), one entry per
            due date ordered ascending with native per-currency totals, or ``None``
            when nothing is due in the window (ADR-089).
    """

    month: str
    top_category_mover: TopCategoryMover | None
    recurring: RecurringExpenses | None
    savings: Savings
    latest_usd_invoice: LatestUsdInvoice | None
    upcoming_card_due: list[UpcomingCardDue] | None
