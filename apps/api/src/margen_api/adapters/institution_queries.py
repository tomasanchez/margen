"""SQLAlchemy reader for the institution query side (ADR-130, ADR-134).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
institution read models. Every query is owner-scoped (ADR-130). All I/O is
awaited.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.institution import InstitutionRecord
from margen_api.domain.models.value_objects import InstitutionType
from margen_api.service_layer.institution_read_models import InstitutionReadModel
from margen_api.service_layer.institution_reader import AbstractInstitutionReader


class SqlAlchemyInstitutionReader(AbstractInstitutionReader):
    """Serve the institutions list from an async session (ADR-134)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_institutions(self, user_id: str) -> list[InstitutionReadModel]:
        """List the owner's institutions newest-first by creation (ADR-130)."""
        statement = (
            select(InstitutionRecord)
            .where(InstitutionRecord.user_id == UUID(user_id))
            .order_by(InstitutionRecord.created_at.desc(), InstitutionRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]


def _to_read_model(record: InstitutionRecord) -> InstitutionReadModel:
    """Project a persisted institution row into a read model (ADR-134)."""
    return InstitutionReadModel(
        id=record.id,
        name=record.name,
        type=InstitutionType.parse(record.type),
        brand=record.card_brand,
        last4=record.card_last4,
    )
