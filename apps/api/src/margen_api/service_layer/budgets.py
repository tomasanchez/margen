"""Pure assembly of the budgets-vs-actuals surface (ADR-125).

The SQLAlchemy adapter reads the owner's per-category targets and reuses the
category summaries aggregation for the month's per-category expense spend (ADR-042),
then hands both maps to these pure functions, which join them into one line per
expense category and compute ``remaining = target - spent`` where a target exists.
Keeping this logic free of I/O makes it fast to unit test (ADR-032) and keeps
SQLAlchemy in the adapter (AGENTS.md). Money is :class:`~decimal.Decimal` (ADR-025).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal

from margen_api.domain.models.value_objects import KNOWN_CATEGORIES, SAVING_BUCKETS, is_essential
from margen_api.service_layer.budget_read_models import BudgetLine, CategoryHistoryLine, SavingLine

# "Income" is an inflow bucket, not a spend category, so it never carries a budget
# target (ADR-125 budgets per *expense* category). Every other known category is a
# candidate line even with no spend and no target this month. The legacy ``Rent``
# alias is folded into ``Housing`` for the candidate set so the surface never shows
# both an empty ``Rent`` and an empty ``Housing`` line; a stored ``Rent`` target is
# still surfaced (it joins via ``targets.keys()`` below).
_NON_EXPENSE_CATEGORIES = frozenset({"Income", "Rent"})
BUDGETABLE_CATEGORIES: frozenset[str] = KNOWN_CATEGORIES - _NON_EXPENSE_CATEGORIES

_ZERO = Decimal(0)
_PERCENT = Decimal("0.1")


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
    target_currencies: Mapping[str, str] | None = None,
    reimbursed: Mapping[str, Decimal] | None = None,
) -> list[BudgetLine]:
    """Join targets, net spend and reimbursements into one line per category (ADR-125, ADR-042, ADR-152, ADR-160).

    For each category in :func:`budgetable_categories`, pairs its ``target`` (the
    budget amount, or ``None`` when unset) with its NET ``spent`` (gross expense minus
    linked reimbursements, floored at zero, ADR-160/162; ``0`` when none), computes
    ``remaining = target - spent`` when a target exists (``None`` otherwise), and flags
    whether the category is essential (a "Needs" floor category, ADR-143) so the client
    can group Needs vs Wants. Each line also carries the ``reimbursed`` reduction (the
    gross linked paybacks before the floor, ADR-159/161) so the client can render a
    reimbursed chip, and the NATIVE currency the target was STORED in
    (``target_currency``, ADR-152/155).

    Args:
        targets: The owner's per-category targets for the month, keyed by category.
        spent: The month's per-category NET expense totals, keyed by category (ADR-160).
        target_currencies: The native currency each target was stored in (``'USD'``
            or ``'ARS'``, ADR-152), keyed by category. Defaults to empty when the
            caller does not supply it; a category absent here yields a ``None``
            ``target_currency`` even if it has a target.
        reimbursed: The gross reimbursement reduction per category (ADR-159/161), keyed
            by category. Defaults to empty; a category absent here reads ``0``.

    Returns:
        One :class:`BudgetLine` per expense category, sorted by category name.
    """
    currencies = target_currencies or {}
    reimbursements = reimbursed or {}
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
                reimbursed=reimbursements.get(category, _ZERO),
                remaining=remaining,
                is_essential=is_essential(category),
                # The native stored currency only makes sense when a target exists;
                # an untargeted category has nothing to denominate (ADR-152).
                target_currency=currencies.get(category) if target is not None else None,
            )
        )
    return lines


def build_saving_lines(savings: Mapping[str, Decimal], income: Decimal | None) -> list[SavingLine]:
    """Project the month's saving-bucket allocations into sorted lines (ADR-138).

    For each ``kind='saving'`` row pairs the bucket key with its ``amount`` and the
    ``percent`` of net spendable income it represents (``amount / income x 100``,
    rounded to one decimal place). ``percent`` is ``None`` when ``income`` is absent
    or non-positive (no base to compute against). Sorted by bucket name for a stable
    client order. Only known :data:`SAVING_BUCKETS` keys are surfaced, so a stray
    non-bucket saving row never appears.

    Args:
        savings: The owner's per-bucket saving allocations for the month, keyed by
            bucket (``kind='saving'`` rows only).
        income: The month's net spendable income the percentages are computed
            against, or ``None`` when no base is set.

    Returns:
        One :class:`SavingLine` per saving bucket, sorted by bucket name.
    """
    lines: list[SavingLine] = []
    for bucket in sorted(savings.keys() & SAVING_BUCKETS):
        amount = savings[bucket]
        if income is not None and income > 0:
            percent = (amount / income * Decimal(100)).quantize(_PERCENT, rounding=ROUND_HALF_UP)
        else:
            percent = None
        lines.append(SavingLine(bucket=bucket, amount=amount, percent=percent))
    return lines


_THREE = Decimal(3)


def build_category_history(monthly_totals: Sequence[Mapping[str, Decimal]]) -> list[CategoryHistoryLine]:
    """Assemble per-category trailing history from three prior months' totals (ADR-145).

    Given the per-category expense totals of the three calendar months immediately
    before the requested month — oldest-first, so ``monthly_totals[-1]`` is the
    single prior month — this computes, for every category present in any window,
    the 3-month average spend and the prior month's spend. A category absent from a
    given month contributes ``0`` for that month, so ``avg3mo`` is always the mean
    over three months (not over "months with spend"). The result is sorted by
    category name for a deterministic client order.

    Args:
        monthly_totals: The three prior months' per-category expense totals
            (ADR-042), oldest-first; the last entry is the single prior month.

    Returns:
        One :class:`CategoryHistoryLine` per expense category seen in any window,
        sorted by category name. Empty when no category has spend in any window.
    """
    categories = sorted({category for totals in monthly_totals for category in totals})
    last_month_totals = monthly_totals[-1]
    lines: list[CategoryHistoryLine] = []
    for category in categories:
        total = sum((totals.get(category, _ZERO) for totals in monthly_totals), _ZERO)
        avg3mo = (total / _THREE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        lines.append(
            CategoryHistoryLine(
                category=category,
                avg3mo=avg3mo,
                last_month=last_month_totals.get(category, _ZERO),
            )
        )
    return lines
