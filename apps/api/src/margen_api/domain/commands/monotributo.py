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
    """Request to capture the current-period Monotributo snapshot (ADR-052, ADR-112).

    The handler computes the trailing-12-month standing for the window ending at
    ``as_of``, scoped to ``user_id``'s transactions, and idempotently UPSERTs it
    keyed by ``(user_id, period_end)`` month. On first capture (when monthly
    snapshots are missing) it also backfills the elapsed trailing months from the
    owner's existing transactions so the prior-period comparison has data
    immediately.

    Attributes:
        as_of: The reference date the trailing-12-month window ends at (the GET
            endpoint passes server "today"; an external cron may pass its own).
        user_id: The owner the snapshot is computed for and attributed to. The
            command carries it explicitly (ADR-108); the GET endpoint passes the
            authenticated caller, the M2M capture endpoint passes the configured
            owner (ADR-112).
    """

    as_of: date
    user_id: str
