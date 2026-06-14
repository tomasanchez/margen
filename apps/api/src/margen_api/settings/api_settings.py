"""
API Settings
"""

from pydantic import BaseModel, EmailStr, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    BACKEND_CORS_ORIGINS: list[str] = ["http://localhost:5173"]
    MONOTRIBUTO_CAPTURE_TOKEN: str | None = None

    # All your additional application configuration should go either here or in
    # separate file in this submodule.

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_prefix="FASTAPI_",
    )
