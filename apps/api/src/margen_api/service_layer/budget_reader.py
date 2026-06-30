"""Reader port for the budgets query side (ADR-125, ADR-042).

The reader serves the budgets-vs-actuals surface: for a month it returns every
expense category with its target and the month's actual spend (reused from the
category summaries aggregation, ADR-042). It is strictly read-only — budget writes
go through commands on the unit of work (ADR-028) — and is owner-scoped so a caller
only ever sees their own targets and spend (ADR-130). The concrete adapter lives
under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.service_layer.budget_read_models import CategoryHistory, MonthlyBudget


class AbstractBudgetReader(ABC):
    """Async, read-only query port for budgets vs actuals (ADR-125)."""

    @abstractmethod
    async def monthly_budget(self, month: date, user_id: str) -> MonthlyBudget:
        """Return the owner's per-category targets vs actual spend for a month (ADR-125, ADR-108).

        Joins the owner's per-category targets for ``month`` with the month's
        per-category expense totals (the same aggregation the summaries reader uses,
        ADR-042) into one line per expense category, each carrying ``target`` (null
        when unset), ``spent`` and ``remaining`` (null when no target). Every source
        query is scoped to ``user_id`` so a caller only sees their own data
        (ADR-108, ADR-130).

        Args:
            month: Any date within the requested calendar month; only its year and
                month are significant.
            user_id: The authenticated owner the targets and spend are scoped to.

        Returns:
            The assembled :class:`MonthlyBudget`.
        """

    @abstractmethod
    async def category_history(self, month: date, user_id: str) -> CategoryHistory:
        """Return the owner's trailing per-category spend history for a month (ADR-145, ADR-108).

        For every expense category present in the trailing spend, computes the mean
        spend over the three calendar months immediately BEFORE ``month`` (e.g. for
        2026-06 the mean of 2026-03/-04/-05) and the single prior month's spend (e.g.
        2026-05). Reuses the same per-category month-expense aggregation the budgets
        "spent" uses (ADR-042). Every source query is scoped to ``user_id`` so a
        caller only sees their own spend (ADR-108, ADR-130).

        Args:
            month: Any date within the requested calendar month; only its year and
                month are significant. The history covers the three months before it.
            user_id: The authenticated owner the spend history is scoped to.

        Returns:
            The assembled :class:`CategoryHistory`.
        """
