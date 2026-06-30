"""Reader port for the budget-income query side (ADR-139, ADR-143).

The reader serves the net-income-base surface: for a month it returns the owner's
net spendable income + household floor (``GET /budget-income``), and a conservative
variable-income suggestion derived from the income ledger (``GET
/budget-income/suggested``). It is strictly read-only — income writes go through the
``UpsertBudgetIncome`` command on the unit of work (ADR-028) — and owner-scoped so a
caller only sees their own figures (ADR-130). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date
from decimal import Decimal

from margen_api.service_layer.budget_income_read_models import BudgetIncomeReadModel


class AbstractBudgetIncomeReader(ABC):
    """Async, read-only query port for the net-income base + floor (ADR-139)."""

    @abstractmethod
    async def income(self, month: date, user_id: str) -> BudgetIncomeReadModel:
        """Return the owner's net-income base + floor for a month (ADR-139, ADR-143).

        Args:
            month: Any date within the requested calendar month; only its year and
                month are significant.
            user_id: The authenticated owner the base is scoped to.

        Returns:
            The :class:`BudgetIncomeReadModel`; its amount/source/floor fields are
            ``None`` when the owner has no base for the month.
        """

    @abstractmethod
    async def suggested_base(self, month: date, user_id: str) -> Decimal | None:
        """Return the conservative variable-income suggestion, or ``None`` (ADR-139).

        Applies the lower-of-trailing-12-average-vs-lowest-month rule over the
        owner's income ledger ending at ``month``; ``None`` when fewer than 12 months
        of history exist (the rule needs a full year). Suggestion only — the user
        accepts it into the manual base (suggest/confirm, ADR-044).

        Args:
            month: The reference month; the trailing-12 window ends at this month.
            user_id: The authenticated owner the ledger is scoped to.

        Returns:
            The suggested base, or ``None`` when history is insufficient.
        """
