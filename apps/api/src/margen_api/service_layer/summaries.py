"""Pure assembly of the monthly summary from raw aggregates (ADR-042).

The SQLAlchemy adapter runs the ``SUM`` / ``GROUP BY`` queries and hands the raw
totals to these pure functions, which compute the 6-month trend, each category's
``share`` of the month's expenses, and the ``delta_pct`` versus the prior month.
Keeping this logic free of I/O makes it fast to unit test (ADR-032) and keeps
SQLAlchemy in the adapter (AGENTS.md).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal

from margen_api.service_layer.summary_read_models import (
    CategorySummary,
    MonthlySummary,
    TrendPoint,
)

TREND_MONTHS = 6
UNCATEGORIZED = "Uncategorized"
_ZERO = Decimal(0)
_HUNDRED = Decimal(100)


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


def trend_window(month: date) -> list[date]:
    """Return the first days of the 6 months ending at ``month``, oldest-first."""
    return [add_months(month, offset) for offset in range(-(TREND_MONTHS - 1), 1)]


def build_trend(month: date, totals_by_month: Mapping[str, Decimal]) -> list[TrendPoint]:
    """Build the oldest-first 6-month expense trend ending at ``month``.

    Args:
        month: The requested month; flagged ``current`` in the result.
        totals_by_month: Expense totals keyed by ``YYYY-MM``. Missing months
            default to ``0``.

    Returns:
        Six trend points, oldest-first, the last one flagged ``current``.
    """
    requested = month_key(month)
    points: list[TrendPoint] = []
    for first_of_month in trend_window(month):
        key = month_key(first_of_month)
        points.append(
            TrendPoint(
                month=key,
                expenses=totals_by_month.get(key, _ZERO),
                current=key == requested,
            )
        )
    return points


def _delta_pct(current: Decimal, prior: Decimal | None) -> Decimal | None:
    """Return the percent change from ``prior`` to ``current``, or ``None``.

    ``None`` when the prior amount is absent or ``0`` (no meaningful base).
    """
    if prior is None or prior == _ZERO:
        return None
    return (current - prior) / prior * _HUNDRED


def build_categories(
    month_totals: Mapping[str, Decimal],
    prior_totals: Mapping[str, Decimal],
) -> list[CategorySummary]:
    """Build the category breakdown for the requested month, sorted by amount.

    Args:
        month_totals: Expense totals for the requested month, keyed by category.
        prior_totals: Expense totals for the prior month, keyed by category, used
            to compute ``delta_pct``.

    Returns:
        Category summaries sorted by amount descending (category name as a stable
        tiebreak), each carrying its ``share`` of the month total and the
        ``delta_pct`` versus the same category in the prior month.
    """
    total = sum(month_totals.values(), _ZERO)
    summaries = [
        CategorySummary(
            category=category,
            amount=amount,
            share=(amount / total * _HUNDRED) if total != _ZERO else _ZERO,
            delta_pct=_delta_pct(amount, prior_totals.get(category)),
        )
        for category, amount in month_totals.items()
    ]
    summaries.sort(key=lambda summary: (-summary.amount, summary.category))
    return summaries


def build_monthly_summary(
    month: date,
    *,
    trend_totals: Mapping[str, Decimal],
    month_category_totals: Mapping[str, Decimal],
    prior_category_totals: Mapping[str, Decimal],
) -> MonthlySummary:
    """Assemble the full monthly summary from the raw SQL aggregates (ADR-042).

    Args:
        month: The requested month.
        trend_totals: Expense totals keyed by ``YYYY-MM`` for the trend window.
        month_category_totals: The requested month's expense totals by category.
        prior_category_totals: The prior month's expense totals by category.

    Returns:
        The assembled :class:`MonthlySummary`.
    """
    return MonthlySummary(
        month=month_key(month),
        trend=build_trend(month, trend_totals),
        categories=build_categories(month_category_totals, prior_category_totals),
    )
