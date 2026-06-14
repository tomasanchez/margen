"""SQLAlchemy adapter for the single-row Monotributo config (ADR-048).

The update handler persists the configured category exclusively through this
adapter, on the unit of work. The table holds a single row (no per-user key yet,
ADR-048); the adapter loads that row and overlays the change, inserting one when
it is somehow absent so the write never silently no-ops. All I/O is awaited
(AGENTS.md).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.monotributo_config import MonotributoConfigRecord
from margen_api.service_layer.monotributo_config_repository import (
    AbstractMonotributoConfigRepository,
)


class SqlAlchemyMonotributoConfigRepository(AbstractMonotributoConfigRepository):
    """Persist the single-row Monotributo config through an async session (ADR-048)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    async def set_config(self, *, current_category: str, activity_type: str | None) -> None:
        """Upsert ``current_category`` (and ``activity_type`` when given) on the single row."""
        record = await self._load_single()
        if record is None:
            self.session.add(
                MonotributoConfigRecord(
                    current_category=current_category,
                    activity_type=activity_type if activity_type is not None else "services",
                )
            )
            return
        record.current_category = current_category
        if activity_type is not None:
            record.activity_type = activity_type

    async def get_config(self) -> tuple[str, str] | None:
        """Return the persisted ``(current_category, activity_type)``, or ``None``."""
        record = await self._load_single()
        if record is None:
            return None
        return record.current_category, record.activity_type

    async def _load_single(self) -> MonotributoConfigRecord | None:
        """Load the single config row, or ``None`` when the table is empty."""
        statement = select(MonotributoConfigRecord).limit(1)
        return (await self.session.execute(statement)).scalar_one_or_none()
