"""SQLAlchemy reader for the transaction query side (ADR-028, ADR-030).

The reader runs read-only queries against an ``AsyncSession`` and projects rows
into :class:`TransactionReadModel` DTOs. It never returns write aggregates and
never mutates state, so it can be wired independently of the unit of work
(AGENTS.md reader ports + read models). All I/O is awaited.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader


def _to_read_model(record: TransactionRecord) -> TransactionReadModel:
    """Project a persisted row into a read model, deriving ``type`` from ``kind``."""
    kind = Kind.parse(record.kind)
    return TransactionReadModel(
        id=record.id,
        occurred_on=record.occurred_on,
        name=record.name,
        kind=kind,
        type=TxType.EXPENSE if kind is Kind.EXPENSE else TxType.INCOME,
        amount=record.amount,
        currency=Currency.parse(record.currency),
        usd_amount=record.usd_amount,
        fx_rate=record.fx_rate,
        fx_rate_type=FxRateType(record.fx_rate_type) if record.fx_rate_type is not None else None,
        fx_rate_as_of=record.fx_rate_as_of,
        category=record.category,
        payment_method=record.payment_method,
        notes=record.notes,
        recurring=record.recurring,
        counts_toward_monotributo=record.counts_toward_monotributo,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


class SqlAlchemyTransactionReader(AbstractTransactionReader):
    """Serve transaction read models from an async session."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_transactions(self) -> list[TransactionReadModel]:
        """List all transactions newest-first by ``occurred_on`` (ADR-030)."""
        statement = select(TransactionRecord).order_by(
            TransactionRecord.occurred_on.desc(),
            TransactionRecord.created_at.desc(),
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]

    async def get_transaction(self, transaction_id: UUID) -> TransactionReadModel | None:
        """Fetch one transaction read model, or ``None`` when absent."""
        record = await self.session.get(TransactionRecord, transaction_id)
        if record is None:
            return None
        return _to_read_model(record)
