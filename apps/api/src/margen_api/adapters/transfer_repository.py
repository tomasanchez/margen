"""SQLAlchemy repository for the ``Transfer`` aggregate (write side) (ADR-135, ADR-130).

The repository is the only place handlers touch persistence for transfer writes. It
maps between the aggregate and its ``TransferRecord`` and awaits all I/O against an
``AsyncSession`` so the event loop is never blocked (AGENTS.md). It does not own the
transaction boundary — the unit of work commits. Every lookup is owner-scoped
(ADR-130): a foreign owner's id is treated as absent so the boundary answers 404
(ADR-111). ``user_id`` is the Supabase ``sub`` string, coerced to ``UUID`` at this
persistence boundary (ADR-094).
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.transfer import to_record
from margen_api.adapters.models.transfer import TransferRecord
from margen_api.domain.models.transfer import Transfer
from margen_api.service_layer.transfer_repository import AbstractTransferRepository


class SqlAlchemyTransferRepository(AbstractTransferRepository):
    """Persist :class:`Transfer` aggregates through an async session (ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, transfer: Transfer) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit.

        Ownership rides on the aggregate: ``to_record`` copies ``transfer.user_id``
        onto the row's ownership column (ADR-094, ADR-130).
        """
        self.session.add(to_record(transfer))

    async def delete(self, transfer_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's row for ``transfer_id`` (ADR-135, ADR-130).

        Scoped to ``user_id``: a row owned by another user is not matched, so the
        delete reports a miss and the boundary answers 404 (ADR-111). The fee
        expenses created with the transfer are independent rows and are untouched
        (ADR-135).
        """
        statement = select(TransferRecord).where(
            TransferRecord.id == transfer_id,
            TransferRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True
