"""Application configuration - root APIRouter.

Defines all FastAPI application endpoints.

Resources:
    1. https://fastapi.tiangolo.com/tutorial/bigger-applications
"""

from fastapi import APIRouter, Depends

from margen_api.entrypoint import (
    accounts,
    insights,
    institutions,
    invoices,
    monitor,
    monotributo,
    settings,
    statements,
    summaries,
    transactions,
)
from margen_api.entrypoint.dependencies import require_auth_user

api_v1_prefix: str = "/api/v1"

root_router: APIRouter = APIRouter()
api_router_v1: APIRouter = APIRouter(prefix=api_v1_prefix)

# Base routers. The monitor router stays unauthenticated on purpose: the
# liveness/readiness probes are infrastructure health checks (ADR-092 gates
# user-facing data routes, not orchestration probes).
root_router.include_router(monitor.router)

# Versioned API routers. Every user-facing router is gated at include level by
# the Supabase JWT guard (ADR-092): a valid end-user token is required to reach
# any of these routes. This iteration gates only — it does not yet filter rows
# by owner (ADR-095); ``require_auth_user`` is applied for identity, and the
# resolved ``user_id`` stays unused until ownership is activated (ADR-094).
#
# The monotributo router is the one exception to include-level gating: its
# POST /monotributo/capture route is a machine-to-machine endpoint guarded by a
# static shared-secret token for an external scheduler (ADR-064). Gating the
# whole monotributo router at include level would DOUBLE-guard that route with
# the user JWT, which the scheduler does not carry — breaking the cron. So the
# human-facing GET /monotributo carries ``require_auth_user`` per-route (declared
# on the route itself in ``entrypoint/monotributo.py``), while the capture route
# keeps ONLY its static-token guard. The capture token guard is never removed or
# stacked with the user JWT.
_auth = [Depends(require_auth_user)]
api_router_v1.include_router(transactions.router, dependencies=_auth)
api_router_v1.include_router(accounts.router, dependencies=_auth)
api_router_v1.include_router(institutions.router, dependencies=_auth)
api_router_v1.include_router(invoices.router, dependencies=_auth)
api_router_v1.include_router(statements.router, dependencies=_auth)
api_router_v1.include_router(summaries.router, dependencies=_auth)
api_router_v1.include_router(insights.router, dependencies=_auth)
api_router_v1.include_router(monotributo.router)
api_router_v1.include_router(settings.router, dependencies=_auth)
