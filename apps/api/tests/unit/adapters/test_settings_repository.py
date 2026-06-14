"""Unit tests for the SQLAlchemy application-settings adapter (ADR-032, ADR-054).

Per ADR-032 these mock the ``AsyncSession`` and the execute result -- no real
database. They assert the single-row read falls back to the documented defaults,
that ``upsert_settings`` overlays only the provided fields onto the loaded row,
and that an absent row is inserted from the documented defaults before the merge
so the write never silently no-ops.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.settings_repository import (
    DEFAULT_DISPLAY_CURRENCY,
    DEFAULT_FX_RATE_TYPE,
    DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    DEFAULT_MONOTRIBUTO_CATEGORY,
    SqlAlchemySettingsRepository,
)


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
    category: str = "C",
    activity: str = "services",
) -> AppSettingsRecord:
    """Build a persisted app_settings row."""
    record = AppSettingsRecord()
    record.preferred_display_currency = currency
    record.fx_default_rate_type = fx
    record.monotributo_current_category = category
    record.monotributo_activity_type = activity
    return record


class TestGetSettings:
    """``get_settings`` projects the row, or returns the documented defaults."""

    async def test_projects_persisted_row(self):
        """GIVEN a persisted row WHEN read THEN its four fields are projected."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(
            _record(currency="USD", fx="official", category="F", activity="bienes")
        )
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        settings = await repo.get_settings()

        # THEN
        assert settings.preferred_display_currency == "USD"
        assert settings.fx_default_rate_type == "official"
        assert settings.monotributo_current_category == "F"
        assert settings.monotributo_activity_type == "bienes"

    async def test_returns_documented_defaults_when_absent(self):
        """GIVEN no row WHEN read THEN the documented defaults come back, never None."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        settings = await repo.get_settings()

        # THEN
        assert settings.preferred_display_currency == DEFAULT_DISPLAY_CURRENCY
        assert settings.fx_default_rate_type == DEFAULT_FX_RATE_TYPE
        assert settings.monotributo_current_category == DEFAULT_MONOTRIBUTO_CATEGORY
        assert settings.monotributo_activity_type == DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE


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
        result = await repo.upsert_settings(preferred_display_currency="USD")

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
            preferred_display_currency="USD",
            fx_default_rate_type="official",
            monotributo_current_category="H",
            monotributo_activity_type="bienes",
        )

        # THEN
        assert result.preferred_display_currency == "USD"
        assert result.fx_default_rate_type == "official"
        assert result.monotributo_current_category == "H"
        assert result.monotributo_activity_type == "bienes"

    async def test_inserts_from_defaults_when_absent_then_merges(self):
        """
        GIVEN no settings row yet
        WHEN upsert is called with one field
        THEN a defaults row is added to the session and the provided field overlays it
        """
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemySettingsRepository(session)

        # WHEN
        result = await repo.upsert_settings(monotributo_current_category="K")

        # THEN — a new row seeded from defaults was added, then the category overlaid.
        session.add.assert_called_once()
        (added,) = session.add.call_args.args
        assert isinstance(added, AppSettingsRecord)
        assert result.monotributo_current_category == "K"
        # Unprovided fields keep the documented defaults the row was seeded from.
        assert result.preferred_display_currency == DEFAULT_DISPLAY_CURRENCY
        assert result.fx_default_rate_type == DEFAULT_FX_RATE_TYPE
        assert result.monotributo_activity_type == DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
