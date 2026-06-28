"""Fixtures for the real-PostgreSQL integration tier.

Every test here is marked ``integration`` and requires a running PostgreSQL
instance addressed by ``TEST_DATABASE_URL`` (an async ``asyncpg`` URL). When
that variable is unset the whole tier is skipped, so offline runs and the
template bake stay green without Docker.
"""

import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from margen_api.adapters.models.base import Base


def _database_name(url: str) -> str:
    """Extract the database name from a SQLAlchemy URL (path after the last '/')."""
    return url.rsplit("/", 1)[-1].split("?", 1)[0]


@pytest.fixture(name="integration_database_url")
def fixture_integration_database_url() -> str:
    """Return the configured integration database URL or skip the tier.

    SAFETY GUARD: the integration fixtures create AND DROP the entire schema
    around every test, so they must never point at a real database. We refuse any
    ``TEST_DATABASE_URL`` whose database name does not contain ``test`` — a hard
    error (not a skip), so a misconfigured run fails loudly *before* any DDL runs
    rather than silently wiping a dev/prod database.
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is not set; skipping the PostgreSQL integration tier")
    database = _database_name(url)
    if "test" not in database.lower():
        raise RuntimeError(  # noqa: TRY003
            f"Refusing to run the destructive integration tier against database {database!r}: "
            "it creates and DROPS all tables. Point TEST_DATABASE_URL at a dedicated test "
            "database whose name contains 'test' (e.g. margen-api-test on port 5433 — "
            "`docker compose --profile test up -d db-test`)."
        )
    return url


@pytest.fixture(name="session_factory")
async def fixture_session_factory(integration_database_url: str) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Create a session factory against the real PostgreSQL database.

    The schema is created and dropped around each test so runs are isolated.
    """
    engine = create_async_engine(integration_database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        async with engine.begin() as connection:
            # Fail fast (loud error) instead of hanging the whole tier forever if a test
            # leaked a connection left ``idle in transaction`` holding a lock — drop_all
            # needs an ACCESS EXCLUSIVE lock and would otherwise block indefinitely.
            await connection.exec_driver_sql("SET lock_timeout = '15s'")
            await connection.run_sync(Base.metadata.drop_all)
        await engine.dispose()
