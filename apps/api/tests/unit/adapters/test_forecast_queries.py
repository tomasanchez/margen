"""Unit tests for the forecast reader's monotributo-cuota derivation (ADR-177).

The committed-stream SQL is exercised end to end by the DB-backed e2e tier
(``tests/e2e/entrypoint/test_forecast.py``). This module covers the pure
``_monotributo_cuota`` helper's branches with a fake configured-category source and
NO database session — the method reads only the configured ``(category, activity_type)``
and looks the cuota up in the in-code scale, so it needs no I/O (ADR-032). It proves the
services vs goods column selection, the no-config path, and the defensive guard for a
configured category that is not on the scale.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.adapters.forecast_queries import SqlAlchemyForecastReader
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository


class _FakeMonotributoRepo(AbstractMonotributoSnapshotRepository):
    """A monotributo repository stub returning a canned configured category (ADR-032)."""

    def __init__(self, configured: tuple[str, str] | None) -> None:
        self._configured = configured

    async def configured_category(self, user_id: str) -> tuple[str, str] | None:
        """Return the canned ``(category, activity_type)`` pair, or ``None``."""
        return self._configured

    async def used_in_window(self, window_start: date, window_end: date, user_id: str) -> Decimal:  # pragma: no cover
        """Unused by the forecast reader."""
        raise NotImplementedError

    async def existing_period_ends(self, user_id: str) -> set[date]:  # pragma: no cover
        """Unused by the forecast reader."""
        raise NotImplementedError

    async def upsert(self, standing, user_id: str) -> None:  # pragma: no cover
        """Unused by the forecast reader."""
        raise NotImplementedError


def _reader(configured: tuple[str, str] | None) -> SqlAlchemyForecastReader:
    """Build a forecast reader over a stub repo; the session is never touched here."""
    return SqlAlchemyForecastReader(session=None, monotributo=_FakeMonotributoRepo(configured))  # type: ignore[arg-type]


class TestMonotributoCuota:
    """The configured monotributo cuota selects the right column, or falls back (ADR-177)."""

    async def test_services_uses_the_services_cuota(self):
        """
        GIVEN a configured services taxpayer in category A
        WHEN the monotributo cuota is derived
        THEN it is category A's services cuota from the current scale
        """
        # WHEN
        cuota = await _reader(("A", "services"))._monotributo_cuota("u")

        # THEN
        assert cuota == get_category("A").cuota_servicios

    async def test_bienes_uses_the_goods_cuota(self):
        """
        GIVEN a configured goods taxpayer in category H
        WHEN the monotributo cuota is derived
        THEN it is category H's goods cuota from the current scale
        """
        # WHEN
        cuota = await _reader(("H", "bienes"))._monotributo_cuota("u")

        # THEN
        assert cuota == get_category("H").cuota_bienes

    async def test_no_config_returns_none(self):
        """
        GIVEN no configured category (no app_settings row)
        WHEN the monotributo cuota is derived
        THEN it is None so the forecast omits the tax leg (ADR-177)
        """
        # WHEN / THEN
        assert await _reader(None)._monotributo_cuota("u") is None

    async def test_unknown_configured_category_returns_none(self):
        """
        GIVEN a configured category that is not on the A-K scale (a defensive guard)
        WHEN the monotributo cuota is derived
        THEN it falls back to None rather than raising (ADR-177)
        """
        # WHEN / THEN — 'Z' is not a scale letter; the KeyError guard yields None.
        assert await _reader(("Z", "services"))._monotributo_cuota("u") is None
