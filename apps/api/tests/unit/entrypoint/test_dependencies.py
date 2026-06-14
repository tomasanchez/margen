"""Unit tests for shared entrypoint dependencies."""

import contextlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from margen_api.adapters.queries import (
    SqlAlchemyMonotributoReader,
    SqlAlchemySettingsReader,
    SqlAlchemySummaryReader,
    SqlAlchemyTransactionReader,
)
from margen_api.entrypoint.dependencies import (
    get_bus,
    get_container,
    get_monotributo_reader,
    get_settings_reader,
    get_summary_reader,
    get_transaction_reader,
)


class TestGetContainer:
    """Test cases for the container dependency resolver."""

    def test_returns_container_from_request_state(self):
        """
        GIVEN a request whose app holds a container in state
        WHEN get_container is called with that request
        THEN it returns the container stored on the app state
        """

        # GIVEN
        container = object()
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(container=container)))

        # WHEN
        resolved = get_container(request)  # type: ignore[arg-type]

        # THEN
        assert resolved is container


class TestGetBus:
    """The bus resolver returns the container's message bus."""

    def test_returns_container_bus(self):
        """
        GIVEN a container holding a bus
        WHEN get_bus is called with it
        THEN it returns that bus
        """
        # GIVEN
        bus = object()
        container = SimpleNamespace(bus=bus)

        # WHEN
        resolved = get_bus(container)  # type: ignore[arg-type]

        # THEN
        assert resolved is bus


class TestGetTransactionReader:
    """The reader resolver opens and closes a request-scoped session."""

    async def test_yields_reader_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the reader dependency is iterated to completion
        THEN it yields a SqlAlchemyTransactionReader and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_transaction_reader(container)  # type: ignore[arg-type]
        reader = await iterator.__anext__()

        # THEN
        assert isinstance(reader, SqlAlchemyTransactionReader)
        assert reader.session is session

        # WHEN the generator is exhausted, the finally block closes the session.
        with contextlib.suppress(StopAsyncIteration):
            await iterator.__anext__()
        session.close.assert_awaited_once()


class TestGetMonotributoReader:
    """The Monotributo reader resolver opens and closes a request-scoped session."""

    async def test_yields_reader_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the Monotributo reader dependency is iterated to completion
        THEN it yields a SqlAlchemyMonotributoReader and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_monotributo_reader(container)  # type: ignore[arg-type]
        reader = await iterator.__anext__()

        # THEN
        assert isinstance(reader, SqlAlchemyMonotributoReader)
        assert reader.session is session

        # WHEN the generator is exhausted, the finally block closes the session.
        with contextlib.suppress(StopAsyncIteration):
            await iterator.__anext__()
        session.close.assert_awaited_once()


class TestGetSettingsReader:
    """The settings reader resolver opens and closes a request-scoped session (ADR-054)."""

    async def test_yields_reader_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the settings reader dependency is iterated to completion
        THEN it yields a SqlAlchemySettingsReader and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_settings_reader(container)  # type: ignore[arg-type]
        reader = await iterator.__anext__()

        # THEN
        assert isinstance(reader, SqlAlchemySettingsReader)
        assert reader.session is session

        # WHEN the generator is exhausted, the finally block closes the session.
        with contextlib.suppress(StopAsyncIteration):
            await iterator.__anext__()
        session.close.assert_awaited_once()


class TestGetSummaryReader:
    """The summary reader resolver opens and closes a request-scoped session."""

    async def test_yields_reader_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the summary reader dependency is iterated to completion
        THEN it yields a SqlAlchemySummaryReader and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_summary_reader(container)  # type: ignore[arg-type]
        reader = await iterator.__anext__()

        # THEN
        assert isinstance(reader, SqlAlchemySummaryReader)
        assert reader.session is session

        # WHEN the generator is exhausted, the finally block closes the session.
        with contextlib.suppress(StopAsyncIteration):
            await iterator.__anext__()
        session.close.assert_awaited_once()
