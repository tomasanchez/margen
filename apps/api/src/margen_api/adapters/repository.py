"""SQLAlchemy repository for the ``Transaction`` aggregate (write side).

The repository is the only place handlers touch persistence for writes. It maps
between the aggregate and its ``TransactionRecord`` (ADR-028) and awaits all I/O
against an ``AsyncSession`` so the event loop is never blocked (AGENTS.md). It
does not own the transaction boundary — the unit of work commits.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
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
        """Stage a new aggregate; the unit of work flushes it on commit.

        Ownership rides on the aggregate: ``to_record`` copies ``transaction.user_id``
        onto the row's ownership column (ADR-094, ADR-108), so the create/import
        handlers attribute every insert to the authenticated owner.
        """
        self.session.add(to_record(transaction))

    async def get(self, transaction_id: UUID, user_id: str) -> Transaction | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-108, ADR-111).

        Scopes the lookup by ``user_id`` so a foreign owner's id is not found — the
        update/delete handlers map that to a 404 at the boundary (ADR-111).
        """
        statement = select(TransactionRecord).where(
            TransactionRecord.id == transaction_id,
            TransactionRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return to_domain(record)

    async def persist(self, transaction: Transaction) -> None:
        """Apply a mutated aggregate to its attached row (update semantics).

        The aggregate was loaded through :meth:`get`, which rehydrates ``user_id``
        from the row, so writing it back via ``update_record`` preserves ownership
        rather than clobbering it (ADR-108).
        """
        record = await self.session.get(TransactionRecord, transaction.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(transaction))
            return
        update_record(record, transaction)

    async def delete(self, transaction_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's row for ``transaction_id`` (ADR-030, ADR-108).

        Scoped to ``user_id``: a row owned by another user is not matched, so the
        delete reports a miss and the boundary answers 404 (ADR-111).
        """
        statement = select(TransactionRecord).where(
            TransactionRecord.id == transaction_id,
            TransactionRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True
