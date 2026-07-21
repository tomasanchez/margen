"""Unit tests for the forecast reader's monotributo-cuota derivation (ADR-177, ADR-067).

The committed-stream SQL is exercised end to end by the DB-backed e2e tier
(``tests/e2e/entrypoint/test_forecast.py``). This module covers the pure
``_monotributo_cuota_by_month`` helper's branches with a fake configured-category source
and NO database session — the method reads only the configured ``(category, activity_type)``
and looks the per-month cuota up in the in-code scale, so it needs no I/O (ADR-032). It
proves the services vs goods column selection, the PER-MONTH vintage resolution across the
Aug-1 2026 scale boundary, the no-config path, and the defensive guard for a configured
category that is not on the scale.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.adapters.forecast_queries import SqlAlchemyForecastReader
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.summaries import month_key


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


# A forecast window straddling the Aug-1 2026 vintage boundary: July uses 2026-02,
# Aug/Sep use 2026-08 (ADR-067).
_BOUNDARY_WINDOW = [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]


class TestMonotributoCuotaByMonth:
    """The configured cuota resolves per month, per vintage, or falls back (ADR-177, ADR-067)."""

    async def test_services_uses_the_services_cuota_per_month_vintage(self):
        """
        GIVEN a configured services taxpayer in category A over a boundary-crossing window
        WHEN the per-month cuota map is derived
        THEN each month carries category A's services cuota for THAT month's vintage: July on
             2026-02, Aug/Sep on 2026-08 (ADR-067)
        """
        # WHEN
        cuota_by_month = await _reader(("A", "services"))._monotributo_cuota_by_month("u", _BOUNDARY_WINDOW)

        # THEN — per-month vintage resolution across the Aug-1 boundary.
        assert cuota_by_month is not None
        assert cuota_by_month == {
            "2026-07": get_category("A", as_of=date(2026, 7, 1)).cuota_servicios,
            "2026-08": get_category("A", as_of=date(2026, 8, 1)).cuota_servicios,
            "2026-09": get_category("A", as_of=date(2026, 9, 1)).cuota_servicios,
        }
        # The vintage change is real: July's cuota differs from Aug's.
        assert cuota_by_month["2026-07"] != cuota_by_month["2026-08"]

    async def test_bienes_uses_the_goods_cuota(self):
        """
        GIVEN a configured goods taxpayer in category H over a single-month window
        WHEN the per-month cuota map is derived
        THEN the month carries category H's goods cuota for that month's vintage
        """
        # WHEN
        month = date(2026, 9, 1)
        cuota_by_month = await _reader(("H", "bienes"))._monotributo_cuota_by_month("u", [month])

        # THEN
        assert cuota_by_month == {month_key(month): get_category("H", as_of=month).cuota_bienes}

    async def test_no_config_returns_none(self):
        """
        GIVEN no configured category (no app_settings row)
        WHEN the per-month cuota map is derived
        THEN it is None so the forecast omits the tax leg (ADR-177)
        """
        # WHEN / THEN
        assert await _reader(None)._monotributo_cuota_by_month("u", _BOUNDARY_WINDOW) is None

    async def test_unknown_configured_category_returns_none(self):
        """
        GIVEN a configured category that is not on the A-K scale (a defensive guard)
        WHEN the per-month cuota map is derived
        THEN it falls back to None rather than raising (ADR-177)
        """
        # WHEN / THEN — 'Z' is not a scale letter; the KeyError guard yields None.
        assert await _reader(("Z", "services"))._monotributo_cuota_by_month("u", _BOUNDARY_WINDOW) is None
