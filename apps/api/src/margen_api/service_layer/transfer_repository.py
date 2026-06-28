"""Repository port for the write side of the transfer aggregate (ADR-135, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. Concrete adapters live under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader
port (ADR-028). Every write is owner-scoped: a foreign owner's id is treated as
absent so the boundary answers 404 (ADR-111, ADR-130).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.domain.models.transfer import Transfer


class AbstractTransferRepository(ABC):
    """Collection-like async store for :class:`Transfer` aggregates (ADR-130)."""

    @abstractmethod
    def add(self, transfer: Transfer) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Ownership rides on the aggregate (``transfer.user_id``), copied onto the row
        so every insert is attributed to the authenticated owner (ADR-130).

        Args:
            transfer: The aggregate to persist.
        """

    @abstractmethod
    async def delete(self, transfer_id: UUID, user_id: str) -> bool:
        """Hard-delete one of the owner's aggregates by identity (ADR-135, ADR-130).

        Scoped to ``user_id``: a foreign owner's id removes nothing and reports a
        miss, so a cross-tenant delete surfaces 404 (ADR-111). Deleting a transfer
        does NOT delete the fee expenses it created — they are independent expense
        transactions (ADR-135).

        Args:
            transfer_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched for this owner.
        """
