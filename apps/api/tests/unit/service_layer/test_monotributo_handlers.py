"""Unit tests for the Monotributo capture handler (ADR-052, ADR-112).

These drive the handler through the in-memory :class:`FakeUnitOfWork` so they run
with no database (ADR-032). They verify the read-records capture UPSERTs the
current period and backfills missing months on first capture, that re-capturing a
period updates rather than duplicates it, and that the capture is scoped to the
command's owner so one user's history is independent of another's (ADR-112). The
configured category now lives in ``app_settings`` (ADR-054); its update handler is
tested with the settings handlers.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.service_layer.monotributo import month_start, trailing_window
from margen_api.service_layer.monotributo_handlers import capture_monotributo_snapshot
from tests.fakes.persistence import FakeUnitOfWork

AS_OF = date(2026, 6, 14)
OWNER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"
OTHER_OWNER = "a1b2c3d4-e5f6-4789-8abc-def012345678"


def _seed_window_total(uow: FakeUnitOfWork, period_end: date, total: str, *, user_id: str = OWNER) -> None:
    """Seed the per-owner per-window included-income total the capture handler reads."""
    window_start, window_end = trailing_window(period_end)
    uow.used_by_window[(user_id, window_start, window_end)] = Decimal(total)


class TestCaptureSnapshot:
    """``capture_monotributo_snapshot`` UPSERTs and backfills on the unit of work."""

    async def test_captures_current_and_backfills_missing_months(self):
        """
        GIVEN no existing snapshots
        WHEN the capture handler runs for June 2026 for an owner
        THEN it captures the owner's current period and backfills the elapsed trailing months
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OWNER), uow)

        # THEN — the current month and 12 prior month-ends are populated (13 in total).
        assert uow.committed is True
        assert (OWNER, month_start(AS_OF)) in uow.snapshots
        assert len(uow.snapshots) == 13
        # Each backfilled row uses the default category when no config exists.
        assert all(standing.category == "A" for standing in uow.snapshots.values())

    async def test_uses_configured_category(self):
        """
        GIVEN a persisted config of category H
        WHEN the capture handler runs
        THEN the captured standings use that category
        """
        # GIVEN
        uow = FakeUnitOfWork()
        uow.config.update({"current_category": "H", "activity_type": "services"})

        # WHEN
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OWNER), uow)

        # THEN
        assert uow.snapshots[OWNER, month_start(AS_OF)].category == "H"

    async def test_recapture_updates_not_duplicates(self):
        """
        GIVEN an already-captured current period
        WHEN the capture handler runs again with a new window total
        THEN the current period row is refreshed in place (the count is unchanged)
        """
        # GIVEN — first capture.
        uow = FakeUnitOfWork()
        _seed_window_total(uow, month_start(AS_OF), "1000000.00")
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OWNER), uow)
        first_count = len(uow.snapshots)
        assert uow.snapshots[OWNER, month_start(AS_OF)].used == Decimal("1000000.00")

        # WHEN — the window total changes and we re-capture.
        _seed_window_total(uow, month_start(AS_OF), "2000000.00")
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OWNER), uow)

        # THEN — same number of rows, current period refreshed (backfilled months skipped).
        assert len(uow.snapshots) == first_count
        assert uow.snapshots[OWNER, month_start(AS_OF)].used == Decimal("2000000.00")

    async def test_capture_is_owner_scoped(self):
        """
        GIVEN two owners with different window totals
        WHEN each runs the capture handler for the same period
        THEN each owner's current-period standing reflects only their own income (ADR-112)
        """
        # GIVEN — two owners, distinct window totals seeded per owner.
        uow = FakeUnitOfWork()
        _seed_window_total(uow, month_start(AS_OF), "1000000.00", user_id=OWNER)
        _seed_window_total(uow, month_start(AS_OF), "9000000.00", user_id=OTHER_OWNER)

        # WHEN
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OWNER), uow)
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=AS_OF, user_id=OTHER_OWNER), uow)

        # THEN — each owner's standing is independent and keyed by (user_id, period_end).
        assert uow.snapshots[OWNER, month_start(AS_OF)].used == Decimal("1000000.00")
        assert uow.snapshots[OTHER_OWNER, month_start(AS_OF)].used == Decimal("9000000.00")
