"""Unit tests for the SQLAlchemy Monotributo write-side adapters (ADR-032).

Per ADR-032 these mock the ``AsyncSession`` and the execute result — no real
database. They assert the snapshot repository UPSERTs by ``period_end`` (insert
when absent, overlay when present) and exposes the focused read helpers. The
configured category now lives in ``app_settings`` (ADR-054); its write-side tests
live with the settings adapter.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.monotributo_repository import (
    SqlAlchemyMonotributoSnapshotRepository,
)
from margen_api.service_layer.monotributo_read_models import MonotributoStanding


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


def _first_result(row: object) -> MagicMock:
    """Wrap a row in a fake result exposing ``first``."""
    result = MagicMock()
    result.first.return_value = row
    return result


def _scalars_result(rows: list[object]) -> MagicMock:
    """Wrap rows in a fake result exposing ``scalars().all``."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    return result


def _standing(period_end: date = date(2026, 6, 1)) -> MonotributoStanding:
    """Build a computed standing to persist."""
    return MonotributoStanding(
        category="A",
        activity_type="services",
        limit=Decimal("8992597.87"),
        used=Decimal("1000000.00"),
        remaining=Decimal("7992597.87"),
        percent_used=Decimal("11.12"),
        status="safe",
        projected_category="A",
        projection_note="Estimate.",
        period_start=date(2025, 6, 1),
        period_end=period_end,
    )


class TestSnapshotRepositoryUpsert:
    """``upsert`` inserts when no row exists for the period, else overlays it."""

    async def test_inserts_when_absent(self):
        """
        GIVEN no existing snapshot for the period_end
        WHEN upsert runs
        THEN a new record is added to the session
        """
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN
        await repo.upsert(_standing())

        # THEN
        session.add.assert_called_once()
        (added,) = session.add.call_args.args
        assert isinstance(added, MonotributoSnapshotRecord)
        assert added.period_end == date(2026, 6, 1)
        assert added.limit_amount == Decimal("8992597.87")

    async def test_overlays_when_present(self):
        """
        GIVEN an existing snapshot row for the period_end
        WHEN upsert runs again
        THEN the existing row is overlaid in place (no duplicate insert)
        """
        # GIVEN
        existing = MonotributoSnapshotRecord()
        existing.period_end = date(2026, 6, 1)
        session = _session()
        session.execute.return_value = _scalar_result(existing)
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN
        await repo.upsert(_standing())

        # THEN — overlaid, not inserted.
        session.add.assert_not_called()
        assert existing.used == Decimal("1000000.00")
        assert existing.category == "A"
        assert existing.status == "safe"


class TestSnapshotRepositoryReads:
    """The repository exposes the focused reads the capture handler needs."""

    async def test_configured_category_returns_pair(self):
        """GIVEN a config row WHEN configured_category runs THEN it returns the pair."""
        # GIVEN
        session = _session()
        session.execute.return_value = _first_result(
            SimpleNamespace(monotributo_current_category="C", monotributo_activity_type="bienes")
        )
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.configured_category() == ("C", "bienes")

    async def test_configured_category_none_when_absent(self):
        """GIVEN no config row WHEN configured_category runs THEN it returns None."""
        # GIVEN
        session = _session()
        session.execute.return_value = _first_result(None)
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.configured_category() is None

    async def test_used_in_window_sums(self):
        """GIVEN a window SUM WHEN used_in_window runs THEN it returns the Decimal total."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(Decimal("4200000.00"))
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.used_in_window(date(2025, 6, 1), date(2026, 6, 1)) == Decimal("4200000.00")

    async def test_used_in_window_zero_when_no_rows(self):
        """GIVEN no included rows WHEN used_in_window runs THEN it returns 0."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.used_in_window(date(2025, 6, 1), date(2026, 6, 1)) == Decimal(0)

    async def test_used_in_window_coerces_float(self):
        """GIVEN a float SUM (SQLite) WHEN used_in_window runs THEN it coerces to Decimal."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(4200000.0)
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.used_in_window(date(2025, 6, 1), date(2026, 6, 1)) == Decimal("4200000.0")

    async def test_existing_period_ends_returns_set(self):
        """GIVEN persisted snapshots WHEN existing_period_ends runs THEN it returns the months."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalars_result([date(2026, 6, 1), date(2026, 5, 1)])
        repo = SqlAlchemyMonotributoSnapshotRepository(session)

        # WHEN / THEN
        assert await repo.existing_period_ends() == {date(2026, 6, 1), date(2026, 5, 1)}
