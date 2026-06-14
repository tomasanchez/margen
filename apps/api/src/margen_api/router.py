"""Application configuration - root APIRouter.

Defines all FastAPI application endpoints.

Resources:
    1. https://fastapi.tiangolo.com/tutorial/bigger-applications
"""

from fastapi import APIRouter

from margen_api.entrypoint import (
    insights,
    invoices,
    monitor,
    monotributo,
    settings,
    statements,
    summaries,
    transactions,
)

api_v1_prefix: str = "/api/v1"

root_router: APIRouter = APIRouter()
api_router_v1: APIRouter = APIRouter(prefix=api_v1_prefix)

# Base routers
root_router.include_router(monitor.router)

# Versioned API routers
api_router_v1.include_router(transactions.router)
api_router_v1.include_router(invoices.router)
api_router_v1.include_router(statements.router)
api_router_v1.include_router(summaries.router)
api_router_v1.include_router(insights.router)
api_router_v1.include_router(monotributo.router)
api_router_v1.include_router(settings.router)
