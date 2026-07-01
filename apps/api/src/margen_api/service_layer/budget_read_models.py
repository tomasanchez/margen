"""Read models for the budgets query side (ADR-125, ADR-042).

Purpose-built, immutable DTOs for the budgets-vs-actuals surface — deliberately
separate from the write aggregate so the two evolve independently (AGENTS.md reader
ports + read models). Each line pairs a category's ``target`` (the budget amount, or
``None`` when unset) with its ``spent`` (the month's actual expense total for the
category, reused from the category summaries aggregation, ADR-042) and the derived
``remaining`` (``target - spent``, ``None`` when no target is set). Money is
:class:`~decimal.Decimal` (ADR-025); for the MVP every figure is ARS-equivalent
(ADR-125 currency note).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from margen_api.domain.models.value_objects import Currency


@dataclass(frozen=True, slots=True)
class BudgetLine:
    """One expense category's target vs actual for a month (ADR-125).

    Attributes:
        category: The expense category label.
        target: The budget target for the category this month, or ``None`` when the
            user has not set one (ADR-125).
        spent: The category's NET expense total for the month — gross expense minus
            linked reimbursements, floored at zero (ADR-160/162), from the shared
            category aggregation (ADR-042/125); ``0`` when the category has no spend.
        reimbursed: The gross reimbursement reduction attributed to this category-month
            (ADR-159/161) — the sum of linked paybacks BEFORE the floor. Lets the client
            render a "reimbursed" chip alongside the net ``spent``. ``0`` when no linked
            payback fell in the category-month. In the budget ``currency`` (ADR-152): the
            USD reduction rides each linked expense's captured rate (ADR-161).
        remaining: ``target - spent`` (net) when a target is set, else ``None`` (there is
            nothing to remain against an unset target, ADR-125).
        is_essential: Whether the category is an essential ("Needs") spend category
            that defines the household floor (ADR-143). Lets the client group Needs
            vs Wants without re-listing the essential set (ADR-140/143).
        target_currency: The NATIVE currency the ``target`` was STORED in
            (``'USD'`` or ``'ARS'``, the row's ``currency`` column, ADR-152), or
            ``None`` when the category has no target set. Independent of the
            requested spend ``currency`` (ADR-152 query param) — it reflects how the
            target was authored, so the client can convert each target to the
            preferred display currency at the current rate (ADR-155).
    """

    category: str
    target: Decimal | None
    spent: Decimal
    reimbursed: Decimal
    remaining: Decimal | None
    is_essential: bool
    target_currency: str | None


@dataclass(frozen=True, slots=True)
class SavingLine:
    """One saving bucket's monthly allocation for a month (ADR-138).

    A ``kind='saving'`` budget row projected for the savings section. Unlike a
    :class:`BudgetLine` it carries no actuals (saving buckets have no expense spend,
    ADR-138); instead it pairs the bucket key with its profile-derived ``amount`` and
    the ``percent`` of net income it represents (``None`` when the income base is
    zero/absent, so no percentage can be computed).

    Attributes:
        bucket: The saving-bucket key (a
            :data:`~margen_api.domain.models.value_objects.SAVING_BUCKETS` value).
        amount: The bucket's monthly allocation, an ARS-equivalent magnitude
            (ADR-025).
        percent: The bucket as a percentage of net spendable income, or ``None``
            when no positive income base exists to compute it against.
    """

    bucket: str
    amount: Decimal
    percent: Decimal | None


@dataclass(frozen=True, slots=True)
class Floor:
    """The household-floor readout for a month (ADR-143, budget-design §9.1.1).

    Attributes:
        amount: The essentials floor the plan must cover, or ``None`` when the user
            has neither set nor computed one.
        source: Provenance of ``amount`` — ``manual`` (user typed) or ``computed``
            (Σ essential spend targets); ``None`` when no floor exists.
    """

    amount: Decimal | None
    source: str | None


@dataclass(frozen=True, slots=True)
class CategoryHistoryLine:
    """One expense category's trailing-spend history for budget templating (ADR-145).

    Backs the Budgets redesign templates ("Match 3-mo avg" / "Match last month")
    and the per-row "use avg" chips: for a requested month it carries the mean of
    the three calendar months immediately before it (``avg3mo``) and the single
    prior month's spend (``last_month``). Money is :class:`~decimal.Decimal`; a
    category with no spend in a window contributes ``0`` there (ADR-025).

    Attributes:
        category: The expense category label.
        avg3mo: The mean ARS-equivalent expense over the 3 calendar months
            immediately before the requested month (e.g. for 2026-06 the mean of
            2026-03, 2026-04 and 2026-05); ``0`` when the category had no spend.
        last_month: The category's ARS-equivalent expense in the single prior month
            (e.g. 2026-05 for 2026-06); ``0`` when the category had no spend.
    """

    category: str
    avg3mo: Decimal
    last_month: Decimal


@dataclass(frozen=True, slots=True)
class CategoryHistory:
    """The trailing per-category spend history for a month (ADR-145).

    Attributes:
        categories: One :class:`CategoryHistoryLine` per expense category present in
            the trailing spend history, sorted by category name. Empty when no spend
            exists in any window.
    """

    categories: list[CategoryHistoryLine]


@dataclass(frozen=True, slots=True)
class MonthlyBudget:
    """The budgets-vs-actuals surface for a month (ADR-125, ADR-138, ADR-143).

    Attributes:
        month: The requested month as ``YYYY-MM`` (the month-navigator period,
            ADR-040).
        currency: The currency the targets and spend are expressed in; ARS for the
            MVP (ADR-125 currency note).
        categories: One :class:`BudgetLine` per expense category, sorted by
            category name. Built ONLY from ``kind='spend'`` rows — saving buckets
            never leak in here (ADR-138).
        savings: One :class:`SavingLine` per ``kind='saving'`` row, sorted by bucket
            name (ADR-138). Empty when no profile has been applied.
        floor: The household-floor readout (essentials vs income), ADR-143.
        suggested_strategy: The pure strategy suggestion (conservative/balanced/
            aggressive), or ``None`` when there is no income base to score against
            (ADR-143). The user still picks.
        pressure: The income-pressure segment (constrained/stable/comfortable), or
            ``None`` when there is no income base (ADR-143).
        unconverted: The count of the month's expense transactions lacking a USD
            snapshot, surfaced so a USD spend total is never silently understated
            (ADR-152). Always ``0`` for an ARS budget (ARS spend needs no snapshot).
    """

    month: str
    currency: Currency
    categories: list[BudgetLine]
    savings: list[SavingLine]
    floor: Floor
    suggested_strategy: str | None
    pressure: str | None
    unconverted: int
