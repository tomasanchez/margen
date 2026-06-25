"""SQLAlchemy adapter for the per-user application settings (ADR-054, ADR-110).

The update handler persists settings exclusively through this adapter, on the
unit of work. The table holds one row per user (ADR-110); the adapter loads the
owner's row and overlays only the provided fields, get-or-creating one from the
documented defaults (with ``user_id`` set) when the owner has none so the write
never silently no-ops. All I/O is awaited (AGENTS.md). ``user_id`` is the
Supabase ``sub`` string, coerced to ``UUID`` at this persistence boundary.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.service_layer.settings_read_models import AppSettings
from margen_api.service_layer.settings_repository import AbstractSettingsRepository

# Documented defaults for a fresh settings row (ADR-054). The category default is
# ``"C"`` and the activity ``"services"`` (the MVP Monotributo path, ADR-046).
DEFAULT_DISPLAY_CURRENCY = "ARS"
DEFAULT_FX_RATE_TYPE = "MEP"
DEFAULT_MONOTRIBUTO_CATEGORY = "C"
DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE = "services"


def _to_read_model(record: AppSettingsRecord) -> AppSettings:
    """Project a persisted settings row into the read model."""
    return AppSettings(
        preferred_display_currency=record.preferred_display_currency,
        fx_default_rate_type=record.fx_default_rate_type,
        monotributo_current_category=record.monotributo_current_category,
        monotributo_activity_type=record.monotributo_activity_type,
    )


def _defaults() -> AppSettings:
    """Return the documented default settings (ADR-054)."""
    return AppSettings(
        preferred_display_currency=DEFAULT_DISPLAY_CURRENCY,
        fx_default_rate_type=DEFAULT_FX_RATE_TYPE,
        monotributo_current_category=DEFAULT_MONOTRIBUTO_CATEGORY,
        monotributo_activity_type=DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    )


class SqlAlchemySettingsRepository(AbstractSettingsRepository):
    """Persist the per-user application settings through an async session (ADR-054, ADR-110)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    async def get_settings(self, user_id: str) -> AppSettings:
        """Return the owner's persisted settings, or the documented defaults when absent."""
        record = await self._load_owned(user_id)
        if record is None:
            return _defaults()
        return _to_read_model(record)

    async def upsert_settings(
        self,
        user_id: str,
        *,
        preferred_display_currency: str | None = None,
        fx_default_rate_type: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
    ) -> AppSettings:
        """Merge the provided fields onto the owner's settings row (ADR-054, ADR-110)."""
        record = await self._load_owned(user_id)
        if record is None:
            record = self._insert_from_defaults(user_id)
        if preferred_display_currency is not None:
            record.preferred_display_currency = preferred_display_currency
        if fx_default_rate_type is not None:
            record.fx_default_rate_type = fx_default_rate_type
        if monotributo_current_category is not None:
            record.monotributo_current_category = monotributo_current_category
        if monotributo_activity_type is not None:
            record.monotributo_activity_type = monotributo_activity_type
        return _to_read_model(record)

    def _insert_from_defaults(self, user_id: str) -> AppSettingsRecord:
        """Add a new owner-scoped settings row seeded from the documented defaults (ADR-110)."""
        record = AppSettingsRecord(
            user_id=UUID(user_id),
            preferred_display_currency=DEFAULT_DISPLAY_CURRENCY,
            fx_default_rate_type=DEFAULT_FX_RATE_TYPE,
            monotributo_current_category=DEFAULT_MONOTRIBUTO_CATEGORY,
            monotributo_activity_type=DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
        )
        self.session.add(record)
        return record

    async def _load_owned(self, user_id: str) -> AppSettingsRecord | None:
        """Load the owner's settings row, or ``None`` when the owner has none (ADR-110)."""
        statement = select(AppSettingsRecord).where(AppSettingsRecord.user_id == UUID(user_id)).limit(1)
        return (await self.session.execute(statement)).scalar_one_or_none()
