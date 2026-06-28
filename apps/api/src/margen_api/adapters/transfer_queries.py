"""SQLAlchemy reader for the transfer query side (ADR-135, ADR-130).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
transfer read models. Every query is owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.transfer import TransferRecord
from margen_api.service_layer.transfer_read_models import TransferReadModel
from margen_api.service_layer.transfer_reader import AbstractTransferReader


class SqlAlchemyTransferReader(AbstractTransferReader):
    """Serve the transfers list from an async session (ADR-135)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_transfers(self, user_id: str) -> list[TransferReadModel]:
        """List the owner's transfers newest-first by occurrence then creation (ADR-130)."""
        statement = (
            select(TransferRecord)
            .where(TransferRecord.user_id == UUID(user_id))
            .order_by(TransferRecord.occurred_on.desc(), TransferRecord.created_at.desc(), TransferRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]


def _to_read_model(record: TransferRecord) -> TransferReadModel:
    """Project a persisted transfer row into a read model (ADR-135)."""
    return TransferReadModel(
        id=record.id,
        from_account_id=record.from_account_id,
        to_account_id=record.to_account_id,
        amount_out=record.amount_out,
        amount_in=record.amount_in,
        occurred_on=record.occurred_on,
        note=record.note,
    )
