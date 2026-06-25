"""Application handler for the Monotributo snapshot capture (ADR-052).

The capture is a "read that records": the GET endpoint (and an external cron)
dispatch :class:`CaptureMonotributoSnapshot`, and this handler idempotently
UPSERTs the current-period snapshot on the unit of work — keeping the query-side
reader strictly read-only. On first capture it also backfills the elapsed trailing
months from existing transactions so the prior-period comparison has data
immediately, with no in-process scheduler (ADR-052). The standing math lives in
the pure :mod:`margen_api.service_layer.monotributo`; this handler contains no
SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from datetime import date

from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.service_layer.monotributo import (
    DEFAULT_ACTIVITY_TYPE,
    DEFAULT_CATEGORY,
    build_standing,
    month_start,
    trailing_window,
)
from margen_api.service_layer.monotributo_read_models import MonotributoStanding
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.summaries import add_months
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# How many trailing month-ends to backfill on first capture so the prior-window
# comparison (ending 12 months ago) has a frozen snapshot to read (ADR-052).
_BACKFILL_MONTHS = 13


async def capture_monotributo_snapshot(
    command: CaptureMonotributoSnapshot,
    uow: AbstractUnitOfWork,
) -> None:
    """Capture the current-period snapshot and backfill missing months (ADR-052).

    Computes the owner's trailing-12-month standing for the window ending at
    ``command.as_of`` and UPSERTs it keyed by ``(user_id, period_end)``. When the
    owner's earlier monthly snapshots are missing it backfills them from the
    owner's existing transactions, so the history self-populates without a
    scheduler. The owner is carried on the command (ADR-108, ADR-112).

    Args:
        command: The validated capture request carrying the reference date and the
            owner ``user_id``.
        uow: The unit of work providing the snapshot repository.
    """
    user_id = command.user_id
    async with uow:
        repo = uow.monotributo_snapshots
        category, activity_type = await _resolve_config(repo, user_id)
        existing = await repo.existing_period_ends(user_id)
        for period_end in _periods_to_capture(command.as_of, existing):
            standing = await _standing_for(
                repo,
                period_end=period_end,
                category=category,
                activity_type=activity_type,
                user_id=user_id,
            )
            await repo.upsert(standing, user_id)
        await uow.commit()


async def _resolve_config(repo: AbstractMonotributoSnapshotRepository, user_id: str) -> tuple[str, str]:
    """Return the owner's persisted ``(category, activity_type)`` or the defaults (ADR-112)."""
    config = await repo.configured_category(user_id)
    if config is None:
        return DEFAULT_CATEGORY, DEFAULT_ACTIVITY_TYPE
    return config


def _periods_to_capture(as_of: date, existing: set[date]) -> list[date]:
    """Return the month-granular reference dates that still need a snapshot.

    All references are normalized to the first day of their month (snapshots are
    month-keyed, ADR-052). Always includes the current period (so the read-records
    UPSERT refreshes it), plus any elapsed trailing month with no snapshot yet
    (backfill).
    """
    current = month_start(as_of)
    # Distinct by construction: `current` plus each prior trailing month.
    candidates = [current, *(add_months(current, -offset) for offset in range(1, _BACKFILL_MONTHS))]
    # The current period is always (re)captured; backfilled months only when missing.
    return [reference for reference in candidates if reference == current or reference not in existing]


async def _standing_for(
    repo: AbstractMonotributoSnapshotRepository,
    *,
    period_end: date,
    category: str,
    activity_type: str,
    user_id: str,
) -> MonotributoStanding:
    """Compute the owner's standing for one trailing window ending at ``period_end`` (ADR-112)."""
    window_start, window_end = trailing_window(period_end)
    used = await repo.used_in_window(window_start, window_end, user_id)
    return build_standing(
        used=used,
        category=category,
        activity_type=activity_type,
        window_start=window_start,
        window_end=window_end,
        reference=period_end,
    )
