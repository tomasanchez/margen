"""Unit tests for the SQLAlchemy application-settings adapter (ADR-032, ADR-054, ADR-110).

Per ADR-032 these mock the ``AsyncSession`` and the execute result -- no real
database. They assert the owner-scoped read falls back to the documented
defaults, that ``upsert_settings`` overlays only the provided fields onto the
owner's loaded row, and that an absent row is get-or-created from the documented
defaults (with ``user_id`` set) before the merge so the write never silently
no-ops (ADR-110).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.settings_repository import (
    DEFAULT_DISPLAY_CURRENCY,
    DEFAULT_FX_RATE_TYPE,
    DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    DEFAULT_MONOTRIBUTO_CATEGORY,
    DEFAULT_MONOTRIBUTO_ENABLED,
    SqlAlchemySettingsRepository,
)

# The owner the per-user settings row is scoped to (ADR-110); a valid UUID string.
OWNER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous ``add``."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


def _scalar_result(value: object) -> MagicMock:
    """Wrap a value in a fake result exposing ``scalar_one_or_none``."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _record(
    *,
    currency: str = "ARS",
    fx: str = "MEP",
    rate_source: str = "bolsa",
    category: str = "C",
    activity: str = "services",
    enabled: bool = True,
) -> AppSettingsRecord:
    """Build a persisted app_settings row."""
    record = AppSettingsRecord()
    record.preferred_display_currency = currency
    record.fx_default_rate_type = fx
    record.preferred_rate_source = rate_source
    record.monotributo_current_category = category
    record.monotributo_activity_type = activity
    record.monotributo_enabled = enabled
    return record


class TestGetSettings:
    """``get_settings`` projects the row, or returns the documented defaults."""

    async def test_projects_persisted_row(self):
        """GIVEN a persisted row WHEN read THEN its four fields are projected."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(
            _record(currency="USD", fx="official", category="F", activity="bienes", enabled=False)
        )
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        settings = await repo.get_settings(OWNER)

        # THEN
        assert settings.preferred_display_currency == "USD"
        assert settings.fx_default_rate_type == "official"
        assert settings.monotributo_current_category == "F"
        assert settings.monotributo_activity_type == "bienes"
        assert settings.monotributo_enabled is False

    async def test_returns_documented_defaults_when_absent(self):
        """GIVEN no row WHEN read THEN the documented defaults come back, never None."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        settings = await repo.get_settings(OWNER)

        # THEN
        assert settings.preferred_display_currency == DEFAULT_DISPLAY_CURRENCY
        assert settings.fx_default_rate_type == DEFAULT_FX_RATE_TYPE
        assert settings.monotributo_current_category == DEFAULT_MONOTRIBUTO_CATEGORY
        assert settings.monotributo_activity_type == DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
        assert settings.monotributo_enabled == DEFAULT_MONOTRIBUTO_ENABLED


class TestUpsertSettings:
    """``upsert_settings`` merges only the provided fields onto the single row."""

    async def test_overlays_only_provided_fields(self):
        """
        GIVEN an existing row
        WHEN upsert is called with only the display currency
        THEN that field is overwritten and the others are left untouched
        """
        # GIVEN
        existing = _record(currency="ARS", fx="MEP", category="C", activity="services")
        session = _session()
        session.execute.return_value = _scalar_result(existing)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(OWNER, preferred_display_currency="USD")

        # THEN — only the currency changed; no new row inserted.
        session.add.assert_not_called()
        assert result.preferred_display_currency == "USD"
        assert result.fx_default_rate_type == "MEP"
        assert result.monotributo_current_category == "C"
        assert result.monotributo_activity_type == "services"

    async def test_overlays_all_fields(self):
        """GIVEN an existing row WHEN all fields are provided THEN all are overwritten."""
        # GIVEN
        existing = _record()
        session = _session()
        session.execute.return_value = _scalar_result(existing)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(
            OWNER,
            preferred_display_currency="USD",
            fx_default_rate_type="official",
            preferred_rate_source="oficial",
            monotributo_current_category="H",
            monotributo_activity_type="bienes",
            monotributo_enabled=False,
        )

        # THEN
        assert result.preferred_display_currency == "USD"
        assert result.fx_default_rate_type == "official"
        assert result.preferred_rate_source == "oficial"
        assert result.monotributo_current_category == "H"
        assert result.monotributo_activity_type == "bienes"
        assert result.monotributo_enabled is False

    async def test_overlays_preferred_rate_source_only(self):
        """
        GIVEN an existing row with the default rate source
        WHEN upsert is called with only ``preferred_rate_source``
        THEN that field changes and the others are untouched (ADR-151)
        """
        # GIVEN
        existing = _record(rate_source="bolsa")
        session = _session()
        session.execute.return_value = _scalar_result(existing)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(OWNER, preferred_rate_source="oficial")

        # THEN — only the rate source changed; no new row inserted.
        session.add.assert_not_called()
        assert result.preferred_rate_source == "oficial"
        assert result.preferred_display_currency == "ARS"

    async def test_toggles_monotributo_enabled_only(self):
        """
        GIVEN an existing row with the module enabled
        WHEN upsert is called with only ``monotributo_enabled=False``
        THEN that flag flips and the other fields are left untouched (ADR-126)
        """
        # GIVEN
        existing = _record(enabled=True)
        session = _session()
        session.execute.return_value = _scalar_result(existing)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(OWNER, monotributo_enabled=False)

        # THEN — only the toggle changed; no new row inserted.
        session.add.assert_not_called()
        assert result.monotributo_enabled is False
        assert result.preferred_display_currency == "ARS"
        assert result.monotributo_current_category == "C"

    async def test_get_or_creates_owner_row_when_absent_then_merges(self):
        """
        GIVEN the owner has no settings row yet
        WHEN upsert is called with one field
        THEN an owner-scoped defaults row is added and the provided field overlays it
        """
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(OWNER, monotributo_current_category="K")

        # THEN — a new row seeded from defaults was added, scoped to the owner, then
        # the category overlaid (ADR-110).
        session.add.assert_called_once()
        (added,) = session.add.call_args.args
        assert isinstance(added, AppSettingsRecord)
        assert added.user_id == UUID(OWNER)
        assert result.monotributo_current_category == "K"
        # Unprovided fields keep the documented defaults the row was seeded from.
        assert result.preferred_display_currency == DEFAULT_DISPLAY_CURRENCY
        assert result.fx_default_rate_type == DEFAULT_FX_RATE_TYPE
        assert result.monotributo_activity_type == DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
        # New users default to the Monotributo module OFF (ADR-126).
        assert result.monotributo_enabled == DEFAULT_MONOTRIBUTO_ENABLED
        assert added.monotributo_enabled is DEFAULT_MONOTRIBUTO_ENABLED
