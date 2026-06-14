"""Test suite for application composition."""

from margen_api.adapters.queries import SqlAlchemySummaryReader, SqlAlchemyTransactionReader
from margen_api.bootstrap import bootstrap
from margen_api.settings.database_settings import DatabaseSettings


class TestBootstrap:
    """Test cases for application dependency composition."""

    async def test_skips_schema_creation_by_default(self):
        """
        GIVEN a container configured without automatic schema creation
        WHEN the application starts and stops
        THEN lifecycle hooks complete without creating tables
        """
        # GIVEN
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))

        # WHEN
        await container.startup()
        await container.shutdown()

        # THEN
        assert container.auto_create_schema is False

    async def test_uses_a_regular_pool_for_a_file_backed_database(self):
        """
        GIVEN a file-backed (non in-memory) database URL
        WHEN the container is composed
        THEN the static-pool branch is skipped and a normal engine is built
        """
        # GIVEN / WHEN
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite:///./build/example.db", AUTO_CREATE_SCHEMA=False))

        # THEN
        assert "memory" not in str(container.engine.url)
        await container.shutdown()

    async def test_reader_factory_builds_a_reader_over_a_fresh_session(self):
        """
        GIVEN a composed container
        WHEN its reader factory is invoked
        THEN it returns a SqlAlchemyTransactionReader over a session
        """
        # GIVEN
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))

        # WHEN
        reader = container.reader_factory()

        # THEN
        assert isinstance(reader, SqlAlchemyTransactionReader)
        await reader.session.close()
        await container.shutdown()

    async def test_summary_reader_factory_builds_a_reader_over_a_fresh_session(self):
        """
        GIVEN a composed container
        WHEN its summary reader factory is invoked
        THEN it returns a SqlAlchemySummaryReader over a session
        """
        # GIVEN
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))

        # WHEN
        reader = container.summary_reader_factory()

        # THEN
        assert isinstance(reader, SqlAlchemySummaryReader)
        await reader.session.close()
        await container.shutdown()
