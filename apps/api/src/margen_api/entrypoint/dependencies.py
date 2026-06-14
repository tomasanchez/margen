"""Shared FastAPI dependencies for entrypoints.

Resolves the process-level application container from request state so that
entrypoint handlers depend on the composition root through dependency
injection rather than module-level globals.
"""

import hmac
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from margen_api.adapters.document_store import SqlAlchemyDocumentStore
from margen_api.adapters.queries import (
    SqlAlchemyInsightsReader,
    SqlAlchemyMonotributoReader,
    SqlAlchemySettingsReader,
    SqlAlchemySummaryReader,
    SqlAlchemyTransactionReader,
)
from margen_api.bootstrap import ApplicationContainer
from margen_api.service_layer.document_store import AbstractDocumentStore
from margen_api.service_layer.insights_reader import AbstractInsightsReader
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.monotributo_reader import AbstractMonotributoReader
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.settings_reader import AbstractSettingsReader
from margen_api.service_layer.summary_reader import AbstractSummaryReader
from margen_api.settings.api_settings import ApplicationSettings


def get_container(request: Request) -> ApplicationContainer:
    """Return application dependencies from FastAPI state."""
    return request.app.state.container


Container = Annotated[ApplicationContainer, Depends(get_container)]


@lru_cache
def get_settings() -> ApplicationSettings:
    """Return the process-level API settings (cached, read from the environment).

    ``ApplicationSettings`` resolves its values from ``FASTAPI_``-prefixed
    environment variables via pydantic-settings; the cache avoids re-reading the
    environment on every request.
    """
    return ApplicationSettings()


Settings = Annotated[ApplicationSettings, Depends(get_settings)]

# HTTP Bearer scheme parser. ``auto_error=False`` lets the guard decide the
# status code itself: a missing/malformed Authorization header must answer 401
# (not the 403 the parser would raise by default) per ADR-064.
_capture_bearer = HTTPBearer(auto_error=False, scheme_name="CaptureToken")


async def require_capture_token(
    settings: Settings,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_capture_bearer)],
) -> None:
    """Guard ``POST /monotributo/capture`` with the shared-secret bearer token (ADR-064).

    The capture write path is exposed to an external scheduler, not a human, so a
    proportionate machine-to-machine control is applied:

    * When ``FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN`` is unset (``None``/empty), the
      endpoint is treated as disabled and fails closed with ``503`` — you cannot
      authenticate against an unset secret.
    * Otherwise an ``Authorization: Bearer <token>`` header is required. A
      missing, malformed, or mismatched bearer answers ``401``. The token is
      compared with :func:`hmac.compare_digest` (constant time) to avoid leaking
      length/content through timing.

    Args:
        settings: The API settings carrying the configured capture token.
        credentials: Parsed bearer credentials, or ``None`` when the
            ``Authorization`` header is absent or not a ``Bearer`` scheme.

    Raises:
        HTTPException: ``503`` when the token is not configured; ``401`` when the
            bearer is missing, malformed, or does not match the configured token.
    """
    configured_token = settings.MONOTRIBUTO_CAPTURE_TOKEN
    if not configured_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Monotributo capture is not configured.",
        )

    if credentials is None or not hmac.compare_digest(credentials.credentials, configured_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing capture token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


CaptureToken = Annotated[None, Depends(require_capture_token)]


def get_bus(container: Container) -> MessageBus:
    """Return the message bus that dispatches commands to handlers."""
    return container.bus


Bus = Annotated[MessageBus, Depends(get_bus)]


async def get_transaction_reader(container: Container) -> AsyncIterator[AbstractTransactionReader]:
    """Yield a transaction reader over a request-scoped read-only session.

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyTransactionReader(session)
    finally:
        await session.close()


TransactionReader = Annotated[AbstractTransactionReader, Depends(get_transaction_reader)]


async def get_summary_reader(container: Container) -> AsyncIterator[AbstractSummaryReader]:
    """Yield a summary reader over a request-scoped read-only session.

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemySummaryReader(session)
    finally:
        await session.close()


SummaryReader = Annotated[AbstractSummaryReader, Depends(get_summary_reader)]


async def get_insights_reader(container: Container) -> AsyncIterator[AbstractInsightsReader]:
    """Yield an insights reader over a request-scoped read-only session (ADR-061).

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyInsightsReader(session)
    finally:
        await session.close()


InsightsReader = Annotated[AbstractInsightsReader, Depends(get_insights_reader)]


async def get_monotributo_reader(container: Container) -> AsyncIterator[AbstractMonotributoReader]:
    """Yield a Monotributo reader over a request-scoped read-only session (ADR-052).

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes. The read-records snapshot write goes
    through the message bus / unit of work instead, keeping this reader read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyMonotributoReader(session)
    finally:
        await session.close()


MonotributoReader = Annotated[AbstractMonotributoReader, Depends(get_monotributo_reader)]


async def get_settings_reader(container: Container) -> AsyncIterator[AbstractSettingsReader]:
    """Yield a settings reader over a request-scoped read-only session (ADR-054).

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes. Settings writes go through the
    message bus / unit of work instead, keeping this reader read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemySettingsReader(session)
    finally:
        await session.close()


SettingsReader = Annotated[AbstractSettingsReader, Depends(get_settings_reader)]


async def get_document_store(container: Container) -> AsyncIterator[AbstractDocumentStore]:
    """Yield a read-only invoice document store over a request-scoped session (ADR-071).

    The parse endpoint uses ``exists_by_natural_key`` for the advisory dedupe flag
    and the attachment endpoint uses ``get`` to stream the stored PDF; both are
    query-only paths that bypass the unit of work by design (ADR-028). The session
    opened here is closed when the request finishes. Document *writes* go through
    the create handler's unit of work instead, keeping this dependency read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyDocumentStore(session)
    finally:
        await session.close()


DocumentReader = Annotated[AbstractDocumentStore, Depends(get_document_store)]
