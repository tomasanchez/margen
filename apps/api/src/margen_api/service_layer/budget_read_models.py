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
        spent: The category's actual ARS-equivalent expense total for the month,
            derived from the category summaries aggregation (ADR-042); ``0`` when the
            category has no spend.
        remaining: ``target - spent`` when a target is set, else ``None`` (there is
            nothing to remain against an unset target, ADR-125).
    """

    category: str
    target: Decimal | None
    spent: Decimal
    remaining: Decimal | None


@dataclass(frozen=True, slots=True)
class MonthlyBudget:
    """The budgets-vs-actuals surface for a month (ADR-125).

    Attributes:
        month: The requested month as ``YYYY-MM`` (the month-navigator period,
            ADR-040).
        currency: The currency the targets and spend are expressed in; ARS for the
            MVP (ADR-125 currency note).
        categories: One :class:`BudgetLine` per expense category, sorted by
            category name (a stable, deterministic order for the client).
    """

    month: str
    currency: Currency
    categories: list[BudgetLine]
