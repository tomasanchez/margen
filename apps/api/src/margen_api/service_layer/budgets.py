"""Pure assembly of the budgets-vs-actuals surface (ADR-125).

The SQLAlchemy adapter reads the owner's per-category targets and reuses the
category summaries aggregation for the month's per-category expense spend (ADR-042),
then hands both maps to these pure functions, which join them into one line per
expense category and compute ``remaining = target - spent`` where a target exists.
Keeping this logic free of I/O makes it fast to unit test (ADR-032) and keeps
SQLAlchemy in the adapter (AGENTS.md). Money is :class:`~decimal.Decimal` (ADR-025).
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal

from margen_api.domain.models.value_objects import KNOWN_CATEGORIES
from margen_api.service_layer.budget_read_models import BudgetLine

# "Income" is an inflow bucket, not a spend category, so it never carries a budget
# target (ADR-125 budgets per *expense* category). Every other known category is a
# candidate line even with no spend and no target this month.
_NON_EXPENSE_CATEGORIES = frozenset({"Income"})
BUDGETABLE_CATEGORIES: frozenset[str] = KNOWN_CATEGORIES - _NON_EXPENSE_CATEGORIES

_ZERO = Decimal(0)


def budgetable_categories(
    targets: Mapping[str, Decimal],
    spent: Mapping[str, Decimal],
) -> list[str]:
    """Return every expense category to surface for the month, sorted (ADR-125).

    The line set is the union of the known expense categories (so an unspent,
    untargeted category still appears), every category that has a target, and every
    category that has spend (so a custom or ``Uncategorized`` category the user
    actually spent in still surfaces). Sorted by name for a deterministic order.

    Args:
        targets: The owner's per-category targets for the month, keyed by category.
        spent: The month's per-category expense totals, keyed by category (ADR-042).

    Returns:
        The category labels to render, sorted alphabetically.
    """
    categories = BUDGETABLE_CATEGORIES | targets.keys() | spent.keys()
    return sorted(categories)


def build_budget_lines(
    targets: Mapping[str, Decimal],
    spent: Mapping[str, Decimal],
) -> list[BudgetLine]:
    """Join targets and spend into one line per expense category (ADR-125, ADR-042).

    For each category in :func:`budgetable_categories`, pairs its ``target`` (the
    budget amount, or ``None`` when unset) with its ``spent`` (the month's actual
    expense total, ``0`` when none) and computes ``remaining = target - spent`` when
    a target exists (``None`` otherwise).

    Args:
        targets: The owner's per-category targets for the month, keyed by category.
        spent: The month's per-category expense totals, keyed by category (ADR-042).

    Returns:
        One :class:`BudgetLine` per expense category, sorted by category name.
    """
    lines: list[BudgetLine] = []
    for category in budgetable_categories(targets, spent):
        target = targets.get(category)
        category_spent = spent.get(category, _ZERO)
        remaining = (target - category_spent) if target is not None else None
        lines.append(
            BudgetLine(
                category=category,
                target=target,
                spent=category_spent,
                remaining=remaining,
            )
        )
    return lines
