"""SQLAlchemy repository for the ``Transaction`` aggregate (write side).

The repository is the only place handlers touch persistence for writes. It maps
between the aggregate and its ``TransactionRecord`` (ADR-028) and awaits all I/O
against an ``AsyncSession`` so the event loop is never blocked (AGENTS.md). It
does not own the transaction boundary — the unit of work commits.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.transaction import to_domain, to_record, update_record
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.transaction import Transaction
from margen_api.service_layer.repository import AbstractTransactionRepository


class SqlAlchemyTransactionRepository(AbstractTransactionRepository):
    """Persist :class:`Transaction` aggregates through an async session."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, transaction: Transaction) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit."""
        self.session.add(to_record(transaction))

    async def get(self, transaction_id: UUID) -> Transaction | None:
        """Load an aggregate by identity, or ``None`` when absent."""
        record = await self.session.get(TransactionRecord, transaction_id)
        if record is None:
            return None
        return to_domain(record)

    async def persist(self, transaction: Transaction) -> None:
        """Apply a mutated aggregate to its attached row (update semantics)."""
        record = await self.session.get(TransactionRecord, transaction.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(transaction))
            return
        update_record(record, transaction)

    async def delete(self, transaction_id: UUID) -> bool:
        """Hard-delete the row for ``transaction_id`` (ADR-030)."""
        record = await self.session.get(TransactionRecord, transaction_id)
        if record is None:
            return False
        await self.session.delete(record)
        return True
