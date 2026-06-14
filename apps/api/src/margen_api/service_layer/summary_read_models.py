"""Read models for the monthly summaries query side (ADR-042).

These are purpose-built, immutable DTOs for the Home spending trend and category
breakdown panels — deliberately separate from the transaction write aggregate so
the two evolve independently (AGENTS.md reader ports + read models). Money is
carried as :class:`~decimal.Decimal` (ADR-025); the API boundary serializes it as
the same Decimal style the transactions endpoint uses (ADR-030).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class TrendPoint:
    """One month of expense total in the 6-month trend (ADR-042).

    Attributes:
        month: Calendar month as ``YYYY-MM``.
        expenses: SUM of the ARS-equivalent expense amounts for the month; ``0``
            when the month has no expenses.
        current: Whether this is the requested month (the trend's last point).
    """

    month: str
    expenses: Decimal
    current: bool


@dataclass(frozen=True, slots=True)
class CategorySummary:
    """One category's spend for the requested month (ADR-042).

    Attributes:
        category: Category label (``"Uncategorized"`` buckets null categories).
        amount: SUM of the ARS-equivalent expense amounts for the category.
        share: Percentage (0-100) of the month's total expenses, ``0`` when the
            month total is ``0``.
        delta_pct: Percent change versus the same category in the prior calendar
            month; ``None`` when the prior amount is ``0`` or absent.
    """

    category: str
    amount: Decimal
    share: Decimal
    delta_pct: Decimal | None


@dataclass(frozen=True, slots=True)
class MonthlySummary:
    """The full monthly summary for the requested month (ADR-042).

    Attributes:
        month: The requested month as ``YYYY-MM``.
        trend: The 6 months ending at ``month``, oldest-first.
        categories: The month's category breakdown, sorted by amount descending.
    """

    month: str
    trend: list[TrendPoint]
    categories: list[CategorySummary]
