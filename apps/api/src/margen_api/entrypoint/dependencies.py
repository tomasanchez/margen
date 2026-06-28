"""Shared FastAPI dependencies for entrypoints.

Resolves the process-level application container from request state so that
entrypoint handlers depend on the composition root through dependency
injection rather than module-level globals.
"""

import hmac
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated, Any

import jwt
from asyncer import asyncify
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from margen_api.adapters.account_queries import SqlAlchemyAccountReader
from margen_api.adapters.document_store import SqlAlchemyDocumentStore
from margen_api.adapters.institution_queries import SqlAlchemyInstitutionReader
from margen_api.adapters.queries import (
    SqlAlchemyInsightsReader,
    SqlAlchemyMonotributoReader,
    SqlAlchemySettingsReader,
    SqlAlchemySummaryReader,
    SqlAlchemyTransactionReader,
)
from margen_api.adapters.statement_store import SqlAlchemyStatementStore
from margen_api.adapters.transfer_queries import SqlAlchemyTransferReader
from margen_api.bootstrap import ApplicationContainer
from margen_api.service_layer.account_reader import AbstractAccountReader
from margen_api.service_layer.document_store import AbstractDocumentStore
from margen_api.service_layer.insights_reader import AbstractInsightsReader
from margen_api.service_layer.institution_reader import AbstractInstitutionReader
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.monotributo_reader import AbstractMonotributoReader
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.settings_reader import AbstractSettingsReader
from margen_api.service_layer.statement_store import AbstractStatementStore
from margen_api.service_layer.summary_reader import AbstractSummaryReader
from margen_api.service_layer.transfer_reader import AbstractTransferReader
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


class AuthUserModel(BaseModel):
    """An authenticated end user resolved from a verified Supabase JWT (ADR-092).

    This is a boundary value object, not a domain aggregate: it carries the
    identity claims the application needs from a token that has already passed
    signature, issuer, audience, and expiry verification. The raw claims are
    preserved so downstream handlers can read additional fields without
    re-parsing the token.

    Attributes:
        id: The subject (``sub``) claim — the Supabase user id.
        email: The ``email`` claim when present, otherwise ``None``.
        claims: The full set of verified claims, kept for downstream use.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    email: str | None = None
    claims: dict[str, Any]


# HTTP Bearer scheme parser for Supabase user JWTs. ``auto_error=False`` lets the
# guard answer 401 itself for a missing/malformed header (not the parser's 403),
# matching the capture-token semantics and the fail-closed contract of ADR-092.
_user_bearer = HTTPBearer(auto_error=False, scheme_name="SupabaseJWT")

# Supabase signs user tokens with EC P-256 keys. Pin the algorithm allow-list to
# ES256 so a token cannot smuggle in a weaker/asymmetric-confusion algorithm.
_SUPABASE_JWT_ALGORITHMS = ["ES256"]

_INVALID_TOKEN_DETAIL = "Invalid or missing authentication token."  # noqa: S105 — error detail, not a secret


@lru_cache
def _get_jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    """Return a process-cached ``PyJWKClient`` for ``jwks_url`` (ADR-092).

    ``PyJWKClient`` fetches the JWKS once and caches the signing keys in memory,
    so verification does not hit the network on every request. Caching the client
    itself (keyed by URL) keeps that key cache alive across requests rather than
    rebuilding it each call.
    """
    return jwt.PyJWKClient(jwks_url)


async def require_auth_user(
    settings: Settings,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_user_bearer)],
) -> AuthUserModel:
    """Authenticate a request bearing a Supabase user JWT (ADR-092).

    User-facing routes are protected by asymmetric verification against
    Supabase's JWKS endpoint — no shared secret. The signing key is fetched from
    the cached JWKS and the token's signature, issuer, audience, and expiry are
    all verified before any claim is trusted.

    The guard fails closed:

    * When ``SUPABASE_JWKS_URL`` or ``SUPABASE_JWT_ISSUER`` is unset (``None``),
      auth is treated as not configured and answers ``503`` — you cannot verify
      against an absent JWKS/issuer.
    * Otherwise an ``Authorization: Bearer <jwt>`` header is required. A missing,
      malformed, expired, wrong-issuer, wrong-audience, or bad-signature token
      answers ``401`` with a constant, non-leaky detail.

    The JWKS fetch inside ``PyJWKClient`` is blocking I/O, so it is offloaded to a
    worker thread with :func:`asyncer.asyncify` to avoid blocking the event loop.

    Args:
        settings: The API settings carrying the Supabase JWKS URL, issuer, and
            audience.
        credentials: Parsed bearer credentials, or ``None`` when the
            ``Authorization`` header is absent or not a ``Bearer`` scheme.

    Returns:
        AuthUserModel: The authenticated user resolved from the verified claims.

    Raises:
        HTTPException: ``503`` when Supabase auth is not configured; ``401`` when
            the token is missing or fails verification for any reason.
    """
    jwks_url = settings.SUPABASE_JWKS_URL
    issuer = settings.SUPABASE_JWT_ISSUER
    if not jwks_url or not issuer:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured.",
        )

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_TOKEN_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    jwks_client = _get_jwks_client(jwks_url)
    try:
        signing_key = await asyncify(jwks_client.get_signing_key_from_jwt)(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=_SUPABASE_JWT_ALGORITHMS,
            audience=settings.SUPABASE_JWT_AUDIENCE,
            issuer=issuer,
            options={"require": ["exp", "sub"]},
        )
    except (jwt.InvalidTokenError, jwt.PyJWKClientError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_TOKEN_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        ) from error

    return AuthUserModel(id=claims["sub"], email=claims.get("email"), claims=claims)


AuthUser = Annotated[AuthUserModel, Depends(require_auth_user)]


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


async def get_statement_store(container: Container) -> AsyncIterator[AbstractStatementStore]:
    """Yield a read-only statement document store over a request-scoped session (ADR-077).

    The parse endpoint uses ``exists_by_natural_key`` for the advisory dedupe flag
    and the download endpoint uses ``get`` to stream the stored PDF; both are
    query-only paths that bypass the unit of work by design (ADR-028). The session
    opened here is closed when the request finishes. Statement *writes* go through
    the import handler's unit of work instead, keeping this dependency read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyStatementStore(session)
    finally:
        await session.close()


StatementReader = Annotated[AbstractStatementStore, Depends(get_statement_store)]


async def get_account_reader(container: Container) -> AsyncIterator[AbstractAccountReader]:
    """Yield an account reader over a request-scoped read-only session (ADR-122).

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes. Account writes go through the message
    bus / unit of work instead, keeping this reader read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyAccountReader(session)
    finally:
        await session.close()


AccountReader = Annotated[AbstractAccountReader, Depends(get_account_reader)]


async def get_institution_reader(container: Container) -> AsyncIterator[AbstractInstitutionReader]:
    """Yield an institution reader over a request-scoped read-only session (ADR-134).

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes. Institution writes go through the
    message bus / unit of work instead, keeping this reader read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyInstitutionReader(session)
    finally:
        await session.close()


InstitutionReader = Annotated[AbstractInstitutionReader, Depends(get_institution_reader)]


async def get_transfer_reader(container: Container) -> AsyncIterator[AbstractTransferReader]:
    """Yield a transfer reader over a request-scoped read-only session (ADR-135).

    Query paths bypass the unit of work by design (ADR-028); the session opened here
    is closed when the request finishes. Transfer writes go through the message bus /
    unit of work instead, keeping this reader read-only.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyTransferReader(session)
    finally:
        await session.close()


TransferReader = Annotated[AbstractTransferReader, Depends(get_transfer_reader)]
