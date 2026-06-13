"""Database settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseSettings):
    """Configure relational persistence."""

    URL: str = "postgresql+asyncpg://margen-api:margen-api@localhost:5432/margen-api"
    AUTO_CREATE_SCHEMA: bool = False

    model_config = SettingsConfigDict(case_sensitive=True, env_prefix="DATABASE_")
