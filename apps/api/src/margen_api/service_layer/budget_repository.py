"""Repository port for the write side of the budget aggregate (ADR-125, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. Concrete adapters live under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader
port (ADR-028). Every read/write is owner-scoped: a foreign owner's row is treated
as absent so the boundary answers 404 (ADR-111, ADR-130). The upsert resolves an
existing target by ``(category, period)`` for the owner so a category never gets a
duplicate target for a month (the UNIQUE constraint, ADR-125).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from datetime import date

from margen_api.domain.models.budget import Budget
from margen_api.domain.models.value_objects import BudgetKind


class AbstractBudgetRepository(ABC):
    """Collection-like async store for :class:`Budget` aggregates (ADR-125, ADR-130)."""

    @abstractmethod
    def add(self, budget: Budget) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Ownership rides on the aggregate (``budget.user_id``), copied onto the row
        so every insert is attributed to the authenticated owner (ADR-130).

        Args:
            budget: The aggregate to persist.
        """

    @abstractmethod
    async def get_by_category_period(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> Budget | None:
        """Load the owner's row for a kind/category/month, or ``None`` (ADR-138, ADR-130).

        Resolves the natural upsert key ``(user_id, kind, category, period)`` so the
        handler can replace an existing row rather than insert a duplicate (ADR-138).
        Scoped to ``user_id`` so a foreign owner's row is never seen (ADR-130).
        ``kind`` defaults to ``SPEND`` so spend callers are unchanged.

        Args:
            category: The expense category / saving bucket the row applies to.
            period: The budget month (first day of the month).
            user_id: The authenticated owner the row must belong to.
            kind: The spend or saving discriminator (ADR-138).

        Returns:
            The aggregate, or ``None`` when the owner has no such row.
        """

    @abstractmethod
    async def list_by_period(
        self,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> Sequence[Budget]:
        """List the owner's rows of a kind for a month (ADR-137, ADR-130).

        Used by the reprice handler to read the source month's ``kind='spend'`` caps
        before repricing them into the target month. Scoped to ``user_id``.

        Args:
            period: The budget month (first day of the month).
            user_id: The authenticated owner the rows must belong to.
            kind: The spend or saving discriminator (ADR-138).

        Returns:
            The owner's aggregates for the kind/month (empty when none).
        """

    @abstractmethod
    async def persist(self, budget: Budget) -> None:
        """Apply the state of a mutated aggregate to its stored row (update semantics).

        Args:
            budget: The mutated aggregate to persist.
        """

    @abstractmethod
    async def delete(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> bool:
        """Hard-delete the owner's row for a kind/category/month (ADR-138, ADR-130).

        Scoped to ``user_id`` so a foreign owner's row is never removed. Clearing an
        absent row reports a miss so the handler stays idempotent (ADR-125). ``kind``
        defaults to ``SPEND``.

        Args:
            category: The expense category / saving bucket the row applies to.
            period: The budget month (first day of the month).
            user_id: The authenticated owner the row must belong to.
            kind: The spend or saving discriminator (ADR-138).

        Returns:
            ``True`` when a row was removed, ``False`` when none existed.
        """
