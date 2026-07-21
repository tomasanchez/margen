"""Integration tests for the settings store against real PostgreSQL (ADR-054).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove the single-row ``app_settings`` upsert/read round-trip (a partial
update merges, not replaces) and that the Monotributo standing now sources its
category from ``app_settings`` (ADR-054/055) — what the mocked fast tiers cannot.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.queries import SqlAlchemyMonotributoReader
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.domain.models.monotributo_scale import get_ceiling

pytestmark = pytest.mark.integration

REFERENCE = date(2026, 6, 14)
# The owner the user-scoped monotributo standing is computed for (ADR-112).
OWNER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


class TestSettingsRoundTrip:
    """The single-row app_settings persists partial updates without clobbering."""

    async def test_partial_upserts_merge(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an empty app_settings
        WHEN a currency-only update is saved, then a category-only update
        THEN each field persists and the earlier change is not overwritten
        """
        # WHEN — first a currency-only change (get-or-creates the owner's row).
        async with session_factory() as session:
            repository = SqlAlchemySettingsRepository(session)
            await repository.upsert_settings(OWNER, preferred_display_currency="USD")
            await session.commit()

        # THEN — currency persists; the other fields are the documented defaults.
        async with session_factory() as session:
            settings = await SqlAlchemySettingsRepository(session).get_settings(OWNER)
        assert settings.preferred_display_currency == "USD"
        assert settings.fx_default_rate_type == "MEP"
        assert settings.monotributo_current_category == "C"
        assert settings.monotributo_activity_type == "services"

        # WHEN — a category-only change later (reuses the owner's row, not a new one).
        async with session_factory() as session:
            repository = SqlAlchemySettingsRepository(session)
            await repository.upsert_settings(OWNER, monotributo_current_category="D")
            await session.commit()

        # THEN — the category updates AND the earlier currency change survives.
        async with session_factory() as session:
            settings = await SqlAlchemySettingsRepository(session).get_settings(OWNER)
        assert settings.monotributo_current_category == "D"
        assert settings.preferred_display_currency == "USD"


class TestMonotributoUsesSettingsCategory:
    """The Monotributo standing reads its category from app_settings (ADR-054)."""

    async def test_standing_uses_configured_category(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN app_settings configured to category E
        WHEN the current Monotributo standing is read from PostgreSQL
        THEN the standing uses category E and its ceiling
        """
        # GIVEN — the owner's settings row is get-or-created scoped to the owner, so
        # the user-scoped snapshot reader resolves it directly (ADR-110, ADR-112).
        async with session_factory() as session:
            repository = SqlAlchemySettingsRepository(session)
            await repository.upsert_settings(OWNER, monotributo_current_category="E")
            await session.commit()

        # WHEN
        async with session_factory() as session:
            standing = await SqlAlchemyMonotributoReader(session).current_standing(REFERENCE, OWNER)

        # THEN — the ceiling resolves for the standing's reference date (2026-02),
        # not the latest published vintage — the standing passes as_of=reference (ADR-067).
        assert standing.category == "E"
        assert standing.limit == get_ceiling("E", as_of=REFERENCE)
