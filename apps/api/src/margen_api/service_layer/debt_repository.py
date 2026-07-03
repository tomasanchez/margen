"""Repository port for the write side of the debt aggregate (ADR-187, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. Concrete adapters live under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader port
(ADR-028). Every read/write is owner-scoped: a foreign owner's id is treated as absent so
the boundary answers 404 (ADR-111, ADR-130).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.domain.models.debt import Debt


class AbstractDebtRepository(ABC):
    """Collection-like async store for :class:`Debt` aggregates (ADR-130)."""

    @abstractmethod
    def add(self, debt: Debt) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Ownership rides on the aggregate (``debt.user_id``), copied onto the row so every
        insert is attributed to the authenticated owner (ADR-130).

        Args:
            debt: The aggregate to persist.
        """

    @abstractmethod
    async def get(self, debt_id: UUID, user_id: str) -> Debt | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-130, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the update
        handler then surfaces a not-found (404 at the boundary, ADR-111).

        Args:
            debt_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The aggregate, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist(self, debt: Debt) -> None:
        """Apply the state of a mutated aggregate to its stored row (update semantics).

        Args:
            debt: The mutated aggregate to persist.
        """

    @abstractmethod
    async def delete(self, debt_id: UUID, user_id: str) -> bool:
        """Hard-delete one of the owner's aggregates by identity (ADR-187, ADR-130).

        Scoped to ``user_id``: a foreign owner's id removes nothing and reports a miss, so
        a cross-tenant delete surfaces 404 (ADR-111).

        Args:
            debt_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched for this owner.
        """
