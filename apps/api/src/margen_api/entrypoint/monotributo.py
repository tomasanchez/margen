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

from fastapi import APIRouter, Depends, HTTPException, status

from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.entrypoint.dependencies import (
    AuthUser,
    Bus,
    MonotributoReader,
    Settings,
    require_capture_token,
)
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
    user: AuthUser,
) -> ResponseModel[MonotributoSnapshotResponse]:
    """Return the caller's Monotributo standing, comparison, scale and drilldown (ADR-052, ADR-112).

    Computes the caller's live trailing-12-month ``current`` standing, the
    prior-window ``previous`` standing for the comparison toggle (read from a saved
    snapshot when one exists, else computed live), the shared AFIP A-K ``scale``,
    and the included invoice drilldown. It then records the caller's current-period
    snapshot (and backfills missing months on first read) by dispatching
    ``CaptureMonotributoSnapshot`` through the bus — the reader stays read-only.

    Scoped to the authenticated caller (ADR-112): the standing and snapshots are
    user-owned, while the AFIP scale stays shared reference data. The identity
    comes from the ``AuthUser`` parameter (a valid Supabase user JWT, ADR-092),
    declared on the handler rather than at router-include level so the sibling
    ``POST /capture`` machine endpoint keeps ONLY its static-token guard (ADR-064)
    and is never double-guarded.
    """
    reference = _today()
    snapshot = await reader.snapshot(reference, user.id)
    # Read-records: persist the caller's current period (and backfill) via the UoW (ADR-052).
    await bus.handle(CaptureMonotributoSnapshot(as_of=reference, user_id=user.id))
    return ResponseModel(data=MonotributoSnapshotResponse.from_read_model(snapshot))


@router.post(
    "/capture",
    name="Capture Monotributo snapshot",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ResponseModel[MonotributoCaptureResponse],
    dependencies=[Depends(require_capture_token)],
)
async def capture_monotributo(bus: Bus, settings: Settings) -> ResponseModel[MonotributoCaptureResponse]:
    """Trigger a Monotributo snapshot capture for the configured owner (ADR-052, ADR-112).

    Thin endpoint for an external scheduler to hit at ARCA's recategorization
    cadence; dispatches ``CaptureMonotributoSnapshot`` through the bus, which
    idempotently UPSERTs the configured owner's current-period snapshot (and
    backfills missing months) on the unit of work.

    The M2M caller authenticates with a static token and carries no user JWT
    (ADR-064), so the snapshot owner is read from configuration: the
    ``FASTAPI_MONOTRIBUTO_OWNER_ID`` env var (ADR-112). When the owner is unset the
    capture fails closed with ``503`` — mirroring the capture-token contract — so
    a snapshot is never written without an explicit owner.

    Guarded by ``require_capture_token`` (ADR-064): the shared-secret bearer token
    must be configured (else ``503``) and the request must carry a matching
    ``Authorization: Bearer <token>`` header (else ``401``).
    """
    owner = settings.MONOTRIBUTO_OWNER_ID
    if not owner:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Monotributo capture owner is not configured.",
        )
    await bus.handle(CaptureMonotributoSnapshot(as_of=_today(), user_id=owner))
    return ResponseModel(data=MonotributoCaptureResponse())
