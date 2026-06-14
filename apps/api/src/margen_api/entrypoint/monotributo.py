"""Monotributo REST entrypoint (ADR-046, ADR-047, ADR-052).

A parameterless read endpoint serving the Monotributo page from a trailing-12-month
window computed against server "today" (ADR-040 — Monotributo ignores the Home
month navigator). The GET is a "read that records": it builds the snapshot via the
read-only :class:`AbstractMonotributoReader`, then dispatches a
``CaptureMonotributoSnapshot`` command so the current-period standing is persisted
(and missing months backfilled) through the unit of work — the reader itself never
writes (ADR-052). Responses use the ``ResponseModel[T]`` envelope with camelCase
JSON (ADR-030).

The thin ``POST /capture`` exists for an external scheduler (k8s CronJob / Azure /
GitHub Actions) to trigger capture at ARCA's recategorization cadence; wiring that
scheduler is a separate devops follow-up (ADR-052).
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, status

from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.entrypoint.dependencies import Bus, MonotributoReader
from margen_api.entrypoint.monotributo_schemas import (
    MonotributoCaptureResponse,
    MonotributoSnapshotResponse,
)
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/monotributo", tags=["Monotributo"])


def _today() -> date:
    """Return the current server date in UTC (the trailing-window reference)."""
    return datetime.now(UTC).date()


@router.get(
    "",
    name="Monotributo standing",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[MonotributoSnapshotResponse],
)
async def monotributo_snapshot(
    reader: MonotributoReader,
    bus: Bus,
) -> ResponseModel[MonotributoSnapshotResponse]:
    """Return the Monotributo standing, comparison, scale and drilldown (ADR-052).

    Computes the live trailing-12-month ``current`` standing, the prior-window
    ``previous`` standing for the comparison toggle (read from a saved snapshot
    when one exists, else computed live), the A-K ``scale``, and the included
    invoice drilldown. It then records the current-period snapshot (and backfills
    missing months on first read) by dispatching ``CaptureMonotributoSnapshot``
    through the bus — the reader stays read-only.
    """
    reference = _today()
    snapshot = await reader.snapshot(reference)
    # Read-records: persist the current period (and backfill) via the UoW (ADR-052).
    await bus.handle(CaptureMonotributoSnapshot(as_of=reference))
    return ResponseModel(data=MonotributoSnapshotResponse.from_read_model(snapshot))


@router.post(
    "/capture",
    name="Capture Monotributo snapshot",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ResponseModel[MonotributoCaptureResponse],
)
async def capture_monotributo(bus: Bus) -> ResponseModel[MonotributoCaptureResponse]:
    """Trigger a Monotributo snapshot capture for the current period (ADR-052).

    Thin endpoint for an external scheduler to hit at ARCA's recategorization
    cadence; dispatches ``CaptureMonotributoSnapshot`` through the bus, which
    idempotently UPSERTs the current-period snapshot (and backfills missing months)
    on the unit of work.

    TODO(ADR-052): add an authentication guard before exposing this remotely — no
    auth dependency exists in the scaffold yet, so this is currently unauthenticated.
    The external-scheduler wiring is a separate devops follow-up issue.
    """
    await bus.handle(CaptureMonotributoSnapshot(as_of=_today()))
    return ResponseModel(data=MonotributoCaptureResponse())
