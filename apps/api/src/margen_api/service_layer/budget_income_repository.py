"""Repository port for the write side of the ``BudgetIncome`` aggregate (ADR-139, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. Concrete adapters live under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader
port (ADR-028). Every read/write is owner-scoped (ADR-130). The upsert resolves an
existing base by ``period`` for the owner so a month never gets a duplicate base (the
UNIQUE constraint, ADR-139). The apply-profile handler also reads the base through
this port (it needs the net income to derive saving amounts).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.domain.models.budget_income import BudgetIncome


class AbstractBudgetIncomeRepository(ABC):
    """Collection-like async store for :class:`BudgetIncome` aggregates (ADR-139, ADR-130)."""

    @abstractmethod
    def add(self, income: BudgetIncome) -> None:
        """Stage a new aggregate for persistence on the next commit (ADR-130).

        Args:
            income: The aggregate to persist.
        """

    @abstractmethod
    async def get_by_period(self, period: date, user_id: str) -> BudgetIncome | None:
        """Load the owner's income base for a month, or ``None`` (ADR-139, ADR-130).

        Resolves the natural upsert key ``(user_id, period)`` so the handler can
        replace an existing base rather than insert a duplicate, and so the
        apply-profile handler can read the net income. Scoped to ``user_id`` so a
        foreign owner's base is never seen (ADR-130).

        Args:
            period: The income month (first day of the month).
            user_id: The authenticated owner the row must belong to.

        Returns:
            The aggregate, or ``None`` when the owner has no base for that month.
        """

    @abstractmethod
    async def persist(self, income: BudgetIncome) -> None:
        """Apply the state of a mutated aggregate to its stored row (update semantics).

        Args:
            income: The mutated aggregate to persist.
        """
