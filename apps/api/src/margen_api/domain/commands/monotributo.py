"""Frozen Pydantic commands for the Monotributo snapshot history (ADR-052).

Capture is a request to record the current trailing-12-month standing — a
"read that records" triggered by the GET endpoint and by an external scheduler.
The command is immutable and boundary-agnostic: it carries only the reference
date the window ends at; the handler does the computation and the idempotent
UPSERT on the unit of work.
"""

from __future__ import annotations

from datetime import date

from margen_api.domain.messages import Command


class CaptureMonotributoSnapshot(Command):
    """Request to capture the current-period Monotributo snapshot (ADR-052).

    The handler computes the trailing-12-month standing for the window ending at
    ``as_of`` and idempotently UPSERTs it keyed by ``period_end`` month. On first
    capture (when monthly snapshots are missing) it also backfills the elapsed
    trailing months from existing transactions so the prior-period comparison has
    data immediately.

    Attributes:
        as_of: The reference date the trailing-12-month window ends at (the GET
            endpoint passes server "today"; an external cron may pass its own).
    """

    as_of: date


class UpdateMonotributoConfig(Command):
    """Request to set the configured Monotributo category (ADR-048).

    The PATCH config endpoint dispatches this to change the single-row
    ``monotributo_config`` (ADR-048): which A-K category is in effect and,
    optionally, the activity type. The handler validates the letter against the
    AFIP scale (ADR-046), normalizes it, and UPSERTs the single row on the unit
    of work. A subsequent GET re-snapshots with the new category (ADR-052).

    Attributes:
        current_category: The category letter A-K to set (validated and
            uppercased by the handler).
        activity_type: The activity type to set ("services"/"bienes"); ``None``
            leaves the persisted value unchanged.
    """

    current_category: str
    activity_type: str | None = None
