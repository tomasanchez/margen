"""Reader port for the transaction query side (ADR-028, ADR-030).

The reader serves query-only paths and returns :class:`TransactionReadModel`
DTOs rather than write aggregates. Keeping it separate from the repository lets
the query path use projections and ordering tuned for reads (AGENTS.md). The
concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.service_layer.read_models import TransactionReadModel


class AbstractTransactionReader(ABC):
    """Async query port returning transaction read models."""

    @abstractmethod
    async def list_transactions(self) -> list[TransactionReadModel]:
        """List every transaction, newest-first (ADR-030).

        Ordered by ``occurred_on`` descending, then ``created_at`` descending as a
        stable tiebreak for rows sharing a date.

        Returns:
            The transactions as read models, newest first.
        """

    @abstractmethod
    async def get_transaction(self, transaction_id: UUID) -> TransactionReadModel | None:
        """Fetch one transaction by identity.

        Args:
            transaction_id: The transaction identity.

        Returns:
            The read model, or ``None`` when no row matches.
        """
