"""
Pytest Fixtures.
"""

from collections.abc import AsyncIterator

import httpx
import pytest
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import Function

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.settings.database_settings import DatabaseSettings


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
