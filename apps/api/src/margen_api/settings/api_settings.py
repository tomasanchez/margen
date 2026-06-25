"""
API Settings
"""

import json
from typing import Annotated

from pydantic import BaseModel, EmailStr, HttpUrl, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from margen_api.version import __version__


class LicenseInfo(BaseModel):
    """Define license information model.

    Attributes:
        name (str): License name.
        url (str): License URL.
    """

    name: str
    url: HttpUrl


class ContactInfo(BaseModel):
    """Define contact information model.

    Attributes:
        name (str): Contact name.
        url (str): Contact URL.
        email (str): Contact email.
    """

    name: str
    url: HttpUrl
    email: EmailStr


class ApplicationSettings(BaseSettings):
    """Define application configuration model.

    Constructor will attempt to determine the values of any fields not passed
    as keyword arguments by reading from the environment. Default values will
    still be used if the matching environment variable is not set.

    Environment variables:
        * FASTAPI_DEBUG
        * FASTAPI_PROJECT_NAME
        * FASTAPI_PROJECT_DESCRIPTION
        * FASTAPI_PROJECT_LICENSE
        * FASTAPI_PROJECT_CONTACT
        * FASTAPI_VERSION
        * FASTAPI_DOCS_URL
        * FASTAPI_BACKEND_CORS_ORIGINS
        * FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN
        * FASTAPI_MONOTRIBUTO_OWNER_ID
        * FASTAPI_SUPABASE_URL
        * FASTAPI_SUPABASE_JWKS_URL
        * FASTAPI_SUPABASE_JWT_ISSUER
        * FASTAPI_SUPABASE_JWT_AUDIENCE

    Attributes:
        DEBUG (bool): FastAPI logging level. You should disable this for
            production.
        PROJECT_NAME (str): FastAPI project name.
        PROJECT_DESCRIPTION (str): FastAPI project description.
        PROJECT_LICENSE (LicenseInfo): FastAPI project license information.
        PROJECT_CONTACT (ContactInfo): FastAPI project contact details.
        VERSION (str): Application version.
        DOCS_URL (str): Path where swagger ui will be served at.
        BACKEND_CORS_ORIGINS (list[str]): Origins allowed by the CORS
            middleware. Defaults to a safe localhost allow-list.
        MONOTRIBUTO_CAPTURE_TOKEN (str | None): Shared-secret bearer token that
            guards ``POST /api/v1/monotributo/capture`` (ADR-064). ``None`` (the
            default) disables the endpoint — it fails closed with ``503`` until
            a machine-to-machine secret is configured.
        MONOTRIBUTO_OWNER_ID (str | None): Supabase user id the machine-to-machine
            Monotributo capture (ADR-064) attributes the computed snapshot to.
            The capture endpoint uses a static token with no user JWT (ADR-112),
            so it reads the owner from configuration. ``None`` (the default)
            leaves the owner unconfigured; a later task fails the capture closed
            with ``503`` until it is set.
        SUPABASE_URL (str | None): Base URL of the Supabase Cloud project (ADR-091),
            e.g. ``https://<ref>.supabase.co``. ``None`` (the default) leaves
            Supabase-backed auth unconfigured; a JWKS auth dependency (ADR-092)
            consumes this in a later task.
        SUPABASE_JWKS_URL (str | None): JWKS endpoint exposing Supabase's
            asymmetric signing keys (ADR-092), e.g.
            ``https://<ref>.supabase.co/auth/v1/.well-known/jwks.json``. Used to
            verify user JWTs without a shared secret.
        SUPABASE_JWT_ISSUER (str | None): Expected ``iss`` claim of Supabase
            tokens, e.g. ``https://<ref>.supabase.co/auth/v1``.
        SUPABASE_JWT_AUDIENCE (str): Expected ``aud`` claim of Supabase tokens.
            Defaults to ``"authenticated"`` (Supabase's audience for signed-in
            users).

    Resources:
        1. https://docs.pydantic.dev/latest/usage/pydantic_settings/
    """

    DEBUG: bool = False
    PROJECT_NAME: str = "Margen API"
    PROJECT_DESCRIPTION: str = "Margen backend API"
    PROJECT_LICENSE: LicenseInfo | None = LicenseInfo(name="MIT", url="https://mit-license.org/")
    PROJECT_CONTACT: ContactInfo | None = ContactInfo(
        name="Tomas Sanchez", url="https://github.com/tomasanchez", email="tomas.sanchez@wheels.com"
    )
    VERSION: str = __version__
    DOCS_URL: str = "/docs"
    BACKEND_CORS_ORIGINS: Annotated[list[str], NoDecode] = ["http://localhost:5173"]
    MONOTRIBUTO_CAPTURE_TOKEN: str | None = None
    MONOTRIBUTO_OWNER_ID: str | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_JWKS_URL: str | None = None
    SUPABASE_JWT_ISSUER: str | None = None
    SUPABASE_JWT_AUDIENCE: str = "authenticated"

    # All your additional application configuration should go either here or in
    # separate file in this submodule.

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def _parse_cors_origins(cls, value: object) -> object:
        """Accept either a JSON array or a comma-separated string for CORS origins.

        ``pydantic-settings`` JSON-decodes list fields read from the environment,
        but dotenv parsers (e.g. ``uv run --env-file .env``) strip the embedded
        double quotes from ``["http://localhost:5173"]``, leaving an unparseable
        ``[http://localhost:5173]``. Accepting a bare comma-separated string keeps
        the env-driven CORS contract (ADR-006/ADR-007) robust under dotenv.

        Args:
            value: The raw field value — a list (default/programmatic case) or a
                string sourced from the environment.

        Returns:
            The value unchanged when it is a list, the JSON-decoded list when the
            string looks like a JSON array, or the comma-separated tokens split
            into a trimmed, non-empty list otherwise.
        """
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                return json.loads(stripped)
            return [origin.strip() for origin in stripped.split(",") if origin.strip()]
        return value

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_prefix="FASTAPI_",
    )
