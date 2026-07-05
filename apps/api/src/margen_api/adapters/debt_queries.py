"""SQLAlchemy reader for the debt query side (ADR-187, ADR-130).

Runs read-only queries against an ``AsyncSession`` and projects rows into the debt read
models. Every query is owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.debt import DebtRecord
from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.debt_read_models import DebtReadModel
from margen_api.service_layer.debt_reader import AbstractDebtReader


class SqlAlchemyDebtReader(AbstractDebtReader):
    """Serve the debts list from an async session (ADR-187)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_debts(self, user_id: str) -> list[DebtReadModel]:
        """List the owner's debts newest-first by creation (ADR-130)."""
        statement = (
            select(DebtRecord)
            .where(DebtRecord.user_id == UUID(user_id))
            .order_by(DebtRecord.created_at.desc(), DebtRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]


def _to_read_model(record: DebtRecord) -> DebtReadModel:
    """Project a persisted debt row into a read model (ADR-187)."""
    return DebtReadModel(
        id=record.id,
        name=record.name,
        currency=Currency.parse(record.currency),
        current_balance=record.current_balance,
        monthly_minimum=record.monthly_minimum,
        rate=record.rate,
    )
