"""Unit tests for the Supabase JWT auth guard (ADR-092, ADR-098).

These tests exercise the real JWKS-verify logic with a locally-minted EC P-256
key pair. The JWKS network fetch is never made: ``PyJWKClient`` is patched so
``get_signing_key_from_jwt`` returns the local public key, keeping the suite
hermetic (ADR-098). They cover valid, expired, wrong-issuer, wrong-audience,
bad-signature, unconfigured, and missing/garbage-token cases.
"""

import datetime as dt
from collections.abc import Iterator
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials

from margen_api.entrypoint.dependencies import (
    AuthUserModel,
    _get_jwks_client,
    require_auth_user,
)
from margen_api.settings.api_settings import ApplicationSettings

JWKS_URL = "https://example.supabase.co/auth/v1/.well-known/jwks.json"
ISSUER = "https://example.supabase.co/auth/v1"
AUDIENCE = "authenticated"
USER_ID = "11111111-2222-3333-4444-555555555555"
USER_EMAIL = "user@example.com"


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    """Build parsed bearer credentials carrying ``token``."""
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


@pytest.fixture(name="signing_keys")
def fixture_signing_keys() -> tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey]:
    """Mint two ES256 (P-256) key pairs: the trusted signer and an impostor."""
    trusted = ec.generate_private_key(ec.SECP256R1())
    impostor = ec.generate_private_key(ec.SECP256R1())
    return trusted, impostor


@pytest.fixture(name="configured_settings")
def fixture_configured_settings() -> ApplicationSettings:
    """Settings with Supabase JWKS/issuer/audience configured."""
    return ApplicationSettings(
        SUPABASE_JWKS_URL=JWKS_URL,
        SUPABASE_JWT_ISSUER=ISSUER,
        SUPABASE_JWT_AUDIENCE=AUDIENCE,
    )


@pytest.fixture(autouse=True)
def _patch_jwks_client(
    monkeypatch: pytest.MonkeyPatch,
    signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
) -> Iterator[None]:
    """Patch ``PyJWKClient.get_signing_key_from_jwt`` to return the local key.

    No network call is made: the guard's cached client hands back an object whose
    ``.key`` is the trusted public key, so verification runs entirely in-memory.
    The ``_get_jwks_client`` lru_cache is cleared so each test rebinds the patch.
    """
    trusted, _ = signing_keys
    public_key = trusted.public_key()
    _get_jwks_client.cache_clear()
    monkeypatch.setattr(
        jwt.PyJWKClient,
        "get_signing_key_from_jwt",
        lambda self, token: SimpleNamespace(key=public_key),
    )
    yield
    _get_jwks_client.cache_clear()


def _mint_token(
    private_key: ec.EllipticCurvePrivateKey,
    *,
    issuer: str = ISSUER,
    audience: str = AUDIENCE,
    expires_in: dt.timedelta = dt.timedelta(hours=1),
    sub: str = USER_ID,
    email: str | None = USER_EMAIL,
) -> str:
    """Mint an ES256 token signed with ``private_key``."""
    now = dt.datetime.now(tz=dt.UTC)
    claims: dict[str, object] = {
        "sub": sub,
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + expires_in,
    }
    if email is not None:
        claims["email"] = email
    return jwt.encode(claims, private_key, algorithm="ES256")


class TestRequireAuthUser:
    """The auth guard verifies Supabase JWTs against the cached JWKS (ADR-092)."""

    async def test_valid_token_returns_auth_user(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a token signed by the trusted key with matching iss/aud
        WHEN the guard verifies it
        THEN it returns an AuthUserModel carrying the sub, email, and raw claims
        """
        # GIVEN
        trusted, _ = signing_keys
        token = _mint_token(trusted)

        # WHEN
        user = await require_auth_user(configured_settings, _bearer(token))

        # THEN
        assert isinstance(user, AuthUserModel)
        assert user.id == USER_ID
        assert user.email == USER_EMAIL
        assert user.claims["iss"] == ISSUER

    async def test_valid_token_without_email(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a valid token that omits the email claim
        WHEN the guard verifies it
        THEN it returns an AuthUserModel whose email is None
        """
        # GIVEN
        trusted, _ = signing_keys
        token = _mint_token(trusted, email=None)

        # WHEN
        user = await require_auth_user(configured_settings, _bearer(token))

        # THEN
        assert user.id == USER_ID
        assert user.email is None

    async def test_expired_token_401(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a token whose exp is in the past
        WHEN the guard verifies it
        THEN it raises 401
        """
        # GIVEN
        trusted, _ = signing_keys
        token = _mint_token(trusted, expires_in=dt.timedelta(hours=-1))

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_wrong_issuer_401(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a token whose iss claim does not match the configured issuer
        WHEN the guard verifies it
        THEN it raises 401
        """
        # GIVEN
        trusted, _ = signing_keys
        token = _mint_token(trusted, issuer="https://evil.supabase.co/auth/v1")

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_wrong_audience_401(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a token whose aud claim does not match the configured audience
        WHEN the guard verifies it
        THEN it raises 401
        """
        # GIVEN
        trusted, _ = signing_keys
        token = _mint_token(trusted, audience="some-other-audience")

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_bad_signature_401(
        self,
        configured_settings: ApplicationSettings,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN a token signed by an impostor key the JWKS does not trust
        WHEN the guard verifies it against the trusted public key
        THEN it raises 401
        """
        # GIVEN
        _, impostor = signing_keys
        token = _mint_token(impostor)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_garbage_bearer_401(
        self,
        configured_settings: ApplicationSettings,
    ):
        """
        GIVEN a bearer carrying a non-JWT string
        WHEN the guard tries to verify it
        THEN it raises 401
        """
        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, _bearer("not-a-jwt"))
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED

    async def test_missing_credentials_401(
        self,
        configured_settings: ApplicationSettings,
    ):
        """
        GIVEN configured Supabase auth
        WHEN the guard runs with no parsed credentials
        THEN it raises 401 with a WWW-Authenticate: Bearer challenge
        """
        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(configured_settings, None)
        assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED
        assert exc_info.value.headers == {"WWW-Authenticate": "Bearer"}

    async def test_503_when_jwks_url_not_configured(
        self,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN settings with no JWKS URL (the fail-closed default)
        WHEN the guard runs with a token present
        THEN it raises 503 — you cannot verify against an absent JWKS
        """
        # GIVEN
        settings = ApplicationSettings(SUPABASE_JWKS_URL=None, SUPABASE_JWT_ISSUER=ISSUER)
        trusted, _ = signing_keys
        token = _mint_token(trusted)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE

    async def test_503_when_issuer_not_configured(
        self,
        signing_keys: tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey],
    ):
        """
        GIVEN settings with a JWKS URL but no issuer
        WHEN the guard runs with a token present
        THEN it raises 503 — issuer is required to verify the iss claim
        """
        # GIVEN
        settings = ApplicationSettings(SUPABASE_JWKS_URL=JWKS_URL, SUPABASE_JWT_ISSUER=None)
        trusted, _ = signing_keys
        token = _mint_token(trusted)

        # WHEN / THEN
        with pytest.raises(HTTPException) as exc_info:
            await require_auth_user(settings, _bearer(token))
        assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
