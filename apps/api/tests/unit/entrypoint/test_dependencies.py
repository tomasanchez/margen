"""Unit tests for shared entrypoint dependencies."""

import contextlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials

from margen_api.adapters.document_store import SqlAlchemyDocumentStore
from margen_api.adapters.queries import (
    SqlAlchemyInsightsReader,
    SqlAlchemyMonotributoReader,
    SqlAlchemySettingsReader,
    SqlAlchemySummaryReader,
    SqlAlchemyTransactionReader,
)
from margen_api.entrypoint.dependencies import (
    get_bus,
    get_container,
    get_document_store,
    get_insights_reader,
    get_monotributo_reader,
    get_settings,
    get_settings_reader,
    get_summary_reader,
    get_transaction_reader,
    require_capture_token,
)
from margen_api.settings.api_settings import ApplicationSettings

CAPTURE_TOKEN = "s3cr3t-capture-token"  # noqa: S105 — test fixture, not a real secret


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    """Build parsed bearer credentials carrying ``token``."""
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


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


class TestGetSettings:
    """The settings resolver builds process-level settings from the environment."""

    def test_returns_application_settings_from_environment(self):
        """
        GIVEN the cached settings resolver
        WHEN get_settings is called
        THEN it returns an ApplicationSettings built from the environment

        The lru_cache is cleared before and after so this test neither reads a
        stale cache nor leaks one into the suite (ADR-066).
        """
        # GIVEN
        get_settings.cache_clear()
        try:
            # WHEN
            settings = get_settings()

            # THEN
            assert isinstance(settings, ApplicationSettings)
        finally:
            get_settings.cache_clear()


class TestRequireCaptureToken:
    """The capture guard fails closed when unconfigured and authenticates otherwise (ADR-064)."""

    async def test_503_when_token_not_configured(self):
        """
        GIVEN settings with no capture token (the fail-closed default)
        WHEN the guard runs with a bearer token present
        THEN it raises 503 — you cannot authenticate against an unset secret
        """
        # GIVEN
        settings = ApplicationSettings(MONOTRIBUTO_CAPTURE_TOKEN=None)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_capture_token(settings, _bearer(CAPTURE_TOKEN))
        assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE

    async def test_401_when_credentials_missing(self):
        """
        GIVEN a configured capture token
        WHEN the guard runs with no parsed credentials
        THEN it raises 401 with a WWW-Authenticate: Bearer challenge
        """
        # GIVEN
        settings = ApplicationSettings(MONOTRIBUTO_CAPTURE_TOKEN=CAPTURE_TOKEN)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_capture_token(settings, None)
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED
        assert exc_info.value.headers == {"WWW-Authenticate": "Bearer"}

    async def test_401_when_token_mismatched(self):
        """
        GIVEN a configured capture token
        WHEN the guard runs with a wrong bearer token
        THEN it raises 401 (constant-time compare rejects the mismatch)
        """
        # GIVEN
        settings = ApplicationSettings(MONOTRIBUTO_CAPTURE_TOKEN=CAPTURE_TOKEN)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_capture_token(settings, _bearer("wrong-token"))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_allows_matching_token(self):
        """
        GIVEN a configured capture token
        WHEN the guard runs with the matching bearer token
        THEN it returns None without raising (request is authorized)
        """
        # GIVEN
        settings = ApplicationSettings(MONOTRIBUTO_CAPTURE_TOKEN=CAPTURE_TOKEN)

        # WHEN
        result = await require_capture_token(settings, _bearer(CAPTURE_TOKEN))

        # THEN
        assert result is None


class TestGetDocumentStore:
    """The document-store resolver opens and closes a request-scoped session."""

    async def test_yields_store_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the document-store dependency is iterated to completion
        THEN it yields a SqlAlchemyDocumentStore and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_document_store(container)  # type: ignore[arg-type]
        store = await iterator.__anext__()

        # THEN
        assert isinstance(store, SqlAlchemyDocumentStore)
        assert store.session is session

        # WHEN exhausted, the finally block closes the session.
        with contextlib.suppress(StopAsyncIteration):
            await iterator.__anext__()
        session.close.assert_awaited_once()


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


class TestGetInsightsReader:
    """The insights reader resolver opens and closes a request-scoped session (ADR-061)."""

    async def test_yields_reader_and_closes_session(self):
        """
        GIVEN a container whose session factory builds a session
        WHEN the insights reader dependency is iterated to completion
        THEN it yields a SqlAlchemyInsightsReader and closes the session
        """
        # GIVEN
        session = AsyncMock()
        container = SimpleNamespace(session_factory=MagicMock(return_value=session))

        # WHEN
        iterator = get_insights_reader(container)  # type: ignore[arg-type]
        reader = await iterator.__anext__()

        # THEN
        assert isinstance(reader, SqlAlchemyInsightsReader)
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
