"""Repository ports for the write side of the transaction aggregate.

Ports describe the persistence contract application handlers depend on, keeping
the handlers free of SQLAlchemy. Concrete adapters live under
``margen_api.adapters`` (AGENTS.md). The repository serves the write model only;
query paths use the reader port (ADR-028).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.domain.models.transaction import Transaction


class AbstractTransactionRepository(ABC):
    """Collection-like async store for :class:`Transaction` aggregates.

    Implementations track the aggregates they touch so the unit of work can
    derive pending domain events; the monitor-only baseline has no events yet
    (ADR-028).
    """

    @abstractmethod
    def add(self, transaction: Transaction) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Args:
            transaction: The aggregate to persist.
        """

    @abstractmethod
    async def get(self, transaction_id: UUID) -> Transaction | None:
        """Load an aggregate by identity.

        Args:
            transaction_id: The aggregate identity.

        Returns:
            The aggregate, or ``None`` when no row matches.
        """

    @abstractmethod
    async def persist(self, transaction: Transaction) -> None:
        """Apply the state of an existing aggregate to its stored row.

        Used by update handlers after mutating a loaded aggregate. Implementations
        copy the aggregate's fields onto the attached record so the change is
        flushed on commit.

        Args:
            transaction: The mutated aggregate to persist.
        """

    @abstractmethod
    async def delete(self, transaction_id: UUID) -> bool:
        """Hard-delete an aggregate by identity (ADR-030).

        Args:
            transaction_id: The aggregate identity.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched.
        """
