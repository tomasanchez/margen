"""
Pytest Fixtures.
"""

import sys
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import Function

from margen_api import asgi
from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.entrypoint.dependencies import AuthUserModel, require_auth_user
from margen_api.settings.database_settings import DatabaseSettings

# A canned authenticated user the e2e tier authenticates as. The coverage gate
# is hermetic (ADR-032): no live Supabase, no minted JWTs. Per ADR-098, e2e tests
# swap the Supabase JWT guard for this stub via ``app.dependency_overrides`` so
# every gated route resolves an identity without a real token. The id is a valid
# UUID string (a real Supabase ``sub`` is a UUID): per ADR-108 it is now threaded
# into the transactions write/read path and stored in the ``UUID`` ownership
# column (ADR-094), which must round-trip on the in-memory SQLite e2e tier.
# Contains hex letters on purpose: an all-digit UUID would hit SQLite's NUMERIC
# affinity on the ``UUID`` ownership column and round-trip back as a float, so the
# stub id keeps letters to stay TEXT on the in-memory e2e tier.
STUB_USER_ID = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"
STUB_AUTH_USER = AuthUserModel(id=STUB_USER_ID, email="stub@example.com", claims={"sub": STUB_USER_ID})

# A SECOND canned authenticated identity (user "B"), used to prove per-user data
# isolation end to end (ADR-113): user A creates data, user B authenticates
# separately, and B must never see or mutate A's rows. Like ``STUB_USER_ID`` it is
# a valid hex-letter UUID so it stays TEXT (not NUMERIC) on the in-memory SQLite
# ``UUID`` ownership column and round-trips on the hermetic e2e tier (ADR-094).
STUB_USER_ID_B = "a1b2c3d4-e5f6-4789-8abc-def012345678"
STUB_AUTH_USER_B = AuthUserModel(id=STUB_USER_ID_B, email="stub-b@example.com", claims={"sub": STUB_USER_ID_B})


def _override_auth(app: FastAPI, user: AuthUserModel = STUB_AUTH_USER) -> None:
    """Install a stub-user auth override on ``app`` (ADR-098/ADR-113).

    Swaps ``require_auth_user`` for a callable returning ``user`` (the default
    single-user stub, or user B for isolation tests) so the JWKS-verify guard
    never runs in the hermetic e2e tier.
    """
    app.dependency_overrides[require_auth_user] = lambda: user


@compiles(Function, "sqlite")
def _compile_generic_function_on_sqlite(element, compiler, **kwargs):  # type: ignore[no-untyped-def]
    """Render Postgres-only server-default functions on the in-memory SQLite tier.

    The offline e2e tier runs the REAL application container on in-memory async
    SQLite (ADR-019), but the persistence models use Postgres ``server_default``
    functions — ``gen_random_uuid()`` for UUID primary keys (ADR-026). SQLite has
    no such builtin, so a write that relies on the DB-generated default (the
    statement-import path's ``statement_document`` insert) fails there. This shim
    maps ``gen_random_uuid()`` to SQLite's own ``hex(randomblob(16))`` UUID-shaped
    expression for the test dialect only; production Postgres is untouched (the
    override is scoped to the ``"sqlite"`` dialect).
    """
    if element.name == "gen_random_uuid":
        return (
            "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || "
            "substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random())%4+1,1) || "
            "substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))"
        )
    return compiler.visit_function(element, **kwargs)


@pytest.fixture(autouse=True)
def fixture_stub_auth(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Authenticate every e2e app as the stub user by default (ADR-098).

    Every e2e module builds its own FastAPI app via ``get_application(...)`` and
    overrides its own ports on that instance. To install the auth override on the
    SAME app instance each test drives — without editing every module — this
    autouse fixture wraps ``get_application`` so each app it returns has the
    stub-user override pre-installed, and republishes the wrapper into every test
    module namespace that imported the name directly (``from margen_api.asgi
    import get_application``).

    A test that needs the REAL guard (the 401-without-token path) clears the
    override on its own app after building it; see ``test_auth.py``.
    """
    original = asgi.get_application

    def wrapped(*args: Any, **kwargs: Any) -> FastAPI:
        app = original(*args, **kwargs)
        _override_auth(app)
        return app

    monkeypatch.setattr(asgi, "get_application", wrapped)
    # Test modules bind ``get_application`` by name at import time, so patching the
    # source module alone is not enough; rebind the name wherever it was imported.
    for module in list(sys.modules.values()):
        if getattr(module, "get_application", None) is original:
            monkeypatch.setattr(module, "get_application", wrapped)
    yield


@pytest.fixture(name="without_auth_override")
def fixture_without_auth_override() -> Callable[[FastAPI], None]:
    """Return a helper that removes the stub-auth override from an app (ADR-098).

    Lets a focused test exercise the REAL ``require_auth_user`` guard (e.g. the
    401-without-token path) on an app that the autouse fixture would otherwise
    have authenticated.
    """

    def remove(app: FastAPI) -> None:
        app.dependency_overrides.pop(require_auth_user, None)

    return remove


@pytest.fixture(name="client_for_user")
def fixture_client_for_user() -> Callable[[ApplicationContainer, AuthUserModel], httpx.AsyncClient]:
    """Return a factory that builds a client authenticated as a chosen user (ADR-113).

    Consolidates the "second app authenticated as a different user" pattern that
    several per-domain isolation tests built inline (transactions, settings,
    statements). The factory builds a fresh FastAPI app over the SAME container —
    so the two users share one in-memory database and B genuinely reads A's
    persisted rows through the real adapters — and installs the auth override for
    the given user on that app (ADR-098).

    The caller owns the returned client's lifecycle (``async with`` it). The
    ``container`` fixture starts and disposes the shared resources, so the apps
    built here only need their auth override.

    Returns:
        A callable ``(container, user) -> httpx.AsyncClient`` building an async
        client authenticated as ``user``.
    """

    def build(container: ApplicationContainer, user: AuthUserModel) -> httpx.AsyncClient:
        app = get_application(container)
        _override_auth(app, user)
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(transport=transport, base_url="http://test")

    return build


@pytest.fixture(name="container")
async def fixture_container() -> AsyncIterator[ApplicationContainer]:
    """Build an isolated in-memory async container with a created schema.

    The offline test tier always runs on in-memory async SQLite regardless of
    the project's chosen runtime database, so collection never touches a real
    ``DATABASE_URL`` or writes a file to the repository.

    Yields:
        ApplicationContainer: A started container; its engine is disposed on
        teardown.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=True))
    await container.startup()
    yield container
    await container.shutdown()


@pytest.fixture(name="test_client")
async def fixture_test_client(container: ApplicationContainer) -> AsyncIterator[httpx.AsyncClient]:
    """Create an async test client backed by the in-memory container.

    ``ASGITransport`` does not run the FastAPI lifespan, so the ``container``
    fixture starts and disposes the application resources instead.

    Yields:
        httpx.AsyncClient: An async client for the app.
    """
    app = get_application(container)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
