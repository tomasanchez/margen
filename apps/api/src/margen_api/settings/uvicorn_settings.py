"""
Uvicorn settings
"""

from ipaddress import ip_address

from pydantic import AliasChoices, Field, IPvAnyAddress
from pydantic_settings import BaseSettings, SettingsConfigDict


class UvicornSettings(BaseSettings):
    """Define UVICORN configuration model.

    Constructor will attempt to determine the values of any fields not passed
    as keyword arguments by reading from the environment. Default values will
    still be used if the matching environment variable is not set.

    Environment variables:
        * UVICORN_HOST
        * UVICORN_PORT (or the unprefixed ``PORT``, see below)
        * UVICORN_LOG_LEVEL
        * UVICORN_RELOAD

    Attributes:
        HOST (IPvAnyAddress): Host to run application on.
        PORT (int): Port to run application on.
        LOG_LEVEL (str): Logging level.
        RELOAD (bool): Enable/disable auto-reload.

    Resources:
        1. https://docs.pydantic.dev/latest/usage/pydantic_settings/
    """

    HOST: IPvAnyAddress = ip_address("127.0.0.1")
    # Honor both ``UVICORN_PORT`` (project default, ADR-006) and the unprefixed
    # ``PORT`` that platform-as-a-service hosts inject (Render, Heroku, Cloud Run
    # all set ``$PORT``). ``UVICORN_PORT`` is checked first so an explicit project
    # override still wins; ``PORT`` lets the app bind the host-assigned port with
    # no per-host code change. Falls back to 8000 when neither is set.
    PORT: int = Field(default=8000, validation_alias=AliasChoices("UVICORN_PORT", "PORT"))
    LOG_LEVEL: str = "info"
    RELOAD: bool = False

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_prefix="UVICORN_",
    )
