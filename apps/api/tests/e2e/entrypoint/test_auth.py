"""Route auth-gate tests for the user-facing API (ADR-092, ADR-098).

The bulk of the e2e tier authenticates as a stub user via the autouse
``fixture_stub_auth`` override (``tests/conftest.py``) so route tests stay
focused on their own contract. This module proves the OTHER side of that
contract: with the stub override removed, a gated route really requires a token
and answers ``401`` when none is presented — exercising the real
``require_auth_user`` guard's fail-closed missing-credentials branch (ADR-092).

The guard checks configuration before credentials, so the Supabase JWKS URL and
issuer are configured through a ``get_settings`` override; with auth configured
but no ``Authorization`` header, the guard returns ``401`` before any JWKS fetch
(no network, keeping the gate hermetic per ADR-032/ADR-098).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from fastapi import FastAPI, status

from margen_api.asgi import get_application
from margen_api.bootstrap import bootstrap
from margen_api.entrypoint.dependencies import get_settings
from margen_api.settings.api_settings import ApplicationSettings
from margen_api.settings.database_settings import DatabaseSettings

# A representative gated user-facing route; any of the gated routers would do.
TRANSACTIONS = "/api/v1/transactions"


@pytest.fixture(name="unauthenticated_client")
async def fixture_unauthenticated_client(
    without_auth_override: Callable[[FastAPI], None],
) -> AsyncIterator[httpx.AsyncClient]:
    """Build a client whose app uses the REAL auth guard (no stub override).

    The autouse stub-auth fixture pre-installs the override on every app; this
    fixture removes it so the real ``require_auth_user`` runs, and configures
    Supabase auth via ``get_settings`` so the guard reaches its missing-token
    ``401`` branch rather than the unconfigured ``503`` branch.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)
    without_auth_override(app)
    app.dependency_overrides[get_settings] = lambda: ApplicationSettings(
        SUPABASE_JWKS_URL="https://example.test/keys",
        SUPABASE_JWT_ISSUER="https://example.test/auth/v1",
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await container.shutdown()


class TestUserRouteAuthGate:
    """User-facing routes require a valid Supabase user JWT (ADR-092)."""

    async def test_returns_401_without_token(self, unauthenticated_client: httpx.AsyncClient):
        """
        GIVEN auth is configured and the stub-auth override has been removed
        WHEN a gated user-facing route is requested with no Authorization header
        THEN the real guard fails closed with 401 and a Bearer challenge
        """
        # WHEN
        response = await unauthenticated_client.get(TRANSACTIONS)

        # THEN
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert response.headers["WWW-Authenticate"] == "Bearer"
