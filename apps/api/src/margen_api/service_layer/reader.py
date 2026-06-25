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
    async def list_transactions(self, user_id: str) -> list[TransactionReadModel]:
        """List the owner's transactions, newest-first (ADR-030, ADR-108).

        Ordered by ``occurred_on`` descending, then ``created_at`` descending as a
        stable tiebreak for rows sharing a date. Scoped to ``user_id`` so a caller
        only ever sees its own rows (ADR-108).

        Args:
            user_id: The authenticated owner whose transactions to list.

        Returns:
            The owner's transactions as read models, newest first.
        """

    @abstractmethod
    async def get_transaction(self, transaction_id: UUID, user_id: str) -> TransactionReadModel | None:
        """Fetch one of the owner's transactions by identity (ADR-108, ADR-111).

        The lookup includes ``user_id`` in the query (filter-in-reader), so another
        user's row simply isn't found and the boundary answers 404 — existence is
        never leaked across tenants (ADR-111).

        Args:
            transaction_id: The transaction identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The read model, or ``None`` when no row matches the id for this owner.
        """
