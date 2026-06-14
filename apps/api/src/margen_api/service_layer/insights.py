"""Pure assembly of the monthly insights from raw aggregates (ADR-060, ADR-061).

The SQLAlchemy adapter runs the ``SUM`` / ``GROUP BY`` / latest-row queries and
hands the raw totals to these pure functions, which pick the biggest positive
category mover versus the prior month, pass the recurring footprint through, and
compute actual-or-projected savings. Keeping this logic free of I/O makes it fast
to unit test (ADR-032) and keeps SQLAlchemy in the adapter (AGENTS.md).
"""

from __future__ import annotations

from calendar import monthrange
from collections.abc import Mapping
from datetime import date
from decimal import Decimal

from margen_api.service_layer.insights_read_models import (
    LatestUsdInvoice,
    MonthlyInsights,
    RecurringExpenses,
    Savings,
    TopCategoryMover,
)
from margen_api.service_layer.summaries import month_key

_ZERO = Decimal(0)
_ONE = Decimal(1)
_HUNDRED = Decimal(100)


def select_top_mover(
    month_totals: Mapping[str, Decimal],
    prior_totals: Mapping[str, Decimal],
) -> TopCategoryMover | None:
    """Return the expense category with the largest positive growth, or ``None``.

    For each category present this month with a non-zero prior total, the percent
    change is ``(current - prior) / prior * 100``. The category with the largest
    such positive change is reported; ties break on the category name for a stable
    result. ``None`` when no category has a prior base or none increased (ADR-060).

    Args:
        month_totals: The requested month's expense totals keyed by category.
        prior_totals: The prior month's expense totals keyed by category.

    Returns:
        The biggest positive mover, or ``None`` when no category increased.
    """
    best: TopCategoryMover | None = None
    for category, current in month_totals.items():
        prior = prior_totals.get(category)
        if prior is None or prior <= _ZERO:
            continue
        delta_pct = (current - prior) / prior * _HUNDRED
        if delta_pct <= _ZERO:
            continue
        if best is None or delta_pct > best.delta_pct or (delta_pct == best.delta_pct and category < best.category):
            best = TopCategoryMover(category=category, delta_pct=delta_pct)
    return best


def build_recurring(count: int, total: Decimal) -> RecurringExpenses | None:
    """Return the recurring-expense footprint, or ``None`` when there are none."""
    if count <= 0:
        return None
    return RecurringExpenses(count=count, total=total)


def elapsed_fraction(month: date, reference: date) -> Decimal:
    """Return the fraction of ``month`` elapsed at ``reference``, in ``(0, 1]``.

    For a past month (the reference falls in a later month) the month is fully
    elapsed, so ``1``. For the current month it is ``reference_day / days_in_month``
    clamped into ``(0, 1]`` so the savings projection never divides by zero and
    never scales a finished month (ADR-060). The Home navigator bounds the request
    to ``<=`` the current month, so a future month is not expected.

    Args:
        month: The first day of the requested month.
        reference: The server "today" used to gauge how much of the month elapsed.

    Returns:
        The elapsed fraction as a ``Decimal`` in ``(0, 1]``.
    """
    if (reference.year, reference.month) != (month.year, month.month):
        return _ONE
    days_in_month = monthrange(month.year, month.month)[1]
    fraction = Decimal(reference.day) / Decimal(days_in_month)
    if fraction <= _ZERO:  # pragma: no cover - a real date.day is >= 1, so fraction is always positive
        return _ONE
    return min(fraction, _ONE)


def build_savings(
    income_total: Decimal,
    expense_total: Decimal,
    month: date,
    reference: date,
) -> Savings:
    """Compute actual-or-projected savings for the month (ADR-060).

    Savings are ``income_total - expense_total``. For the current month the figure
    is projected to month-end by dividing by the elapsed fraction and flagged
    ``is_projected``; for a past month the actual savings are returned with an
    elapsed fraction of ``1``.

    Args:
        income_total: SUM of ARS-equivalent income + invoice amounts for the month.
        expense_total: SUM of ARS-equivalent expense amounts for the month.
        month: The first day of the requested month.
        reference: The server "today" driving the projection.

    Returns:
        The :class:`Savings` fact for the month.
    """
    actual = income_total - expense_total
    fraction = elapsed_fraction(month, reference)
    is_projected = (reference.year, reference.month) == (month.year, month.month)
    amount = actual / fraction if is_projected else actual
    return Savings(amount=amount, is_projected=is_projected, elapsed_fraction=fraction)


def build_monthly_insights(
    month: date,
    reference: date,
    *,
    month_category_totals: Mapping[str, Decimal],
    prior_category_totals: Mapping[str, Decimal],
    recurring_count: int,
    recurring_total: Decimal,
    income_total: Decimal,
    expense_total: Decimal,
    latest_usd_invoice: LatestUsdInvoice | None,
) -> MonthlyInsights:
    """Assemble the full monthly insights from the raw aggregates (ADR-060, ADR-061).

    Args:
        month: The requested month.
        reference: The server "today" driving the savings projection.
        month_category_totals: The requested month's expense totals by category.
        prior_category_totals: The prior month's expense totals by category.
        recurring_count: Number of recurring expenses in the month.
        recurring_total: SUM of the recurring expenses' ARS-equivalent amounts.
        income_total: SUM of the month's ARS-equivalent income + invoice amounts.
        expense_total: SUM of the month's ARS-equivalent expense amounts.
        latest_usd_invoice: The latest USD transaction with an applied rate, or
            ``None`` when the month has none.

    Returns:
        The assembled :class:`MonthlyInsights`.
    """
    return MonthlyInsights(
        month=month_key(month),
        top_category_mover=select_top_mover(month_category_totals, prior_category_totals),
        recurring=build_recurring(recurring_count, recurring_total),
        savings=build_savings(income_total, expense_total, month, reference),
        latest_usd_invoice=latest_usd_invoice,
    )
