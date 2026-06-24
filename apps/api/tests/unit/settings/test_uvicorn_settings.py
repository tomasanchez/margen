"""
Uvicorn settings tests.
"""

import pytest

from margen_api.settings.uvicorn_settings import UvicornSettings


class TestUvicornSettings:
    """
    Test suite for Uvicorn Settings
    """

    def test_uvicorn_default_values(self):
        """
        Test API default values
        """
        settings = UvicornSettings()

        assert not settings.RELOAD
        assert settings.LOG_LEVEL
        assert settings.PORT
        assert settings.HOST

    def test_port_defaults_to_8000(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN no port environment variable is set
        WHEN the settings are loaded
        THEN PORT falls back to 8000
        """
        # GIVEN
        monkeypatch.delenv("UVICORN_PORT", raising=False)
        monkeypatch.delenv("PORT", raising=False)

        # WHEN
        settings = UvicornSettings()

        # THEN
        assert settings.PORT == 8000

    def test_port_reads_unprefixed_port(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN only the unprefixed PORT is set (as Render/Heroku inject it)
        WHEN the settings are loaded
        THEN PORT binds the host-assigned port with no UVICORN_ prefix
        """
        # GIVEN
        monkeypatch.delenv("UVICORN_PORT", raising=False)
        monkeypatch.setenv("PORT", "10000")

        # WHEN
        settings = UvicornSettings()

        # THEN
        assert settings.PORT == 10000

    def test_uvicorn_port_takes_precedence_over_port(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN both UVICORN_PORT and PORT are set
        WHEN the settings are loaded
        THEN the explicit UVICORN_PORT override wins
        """
        # GIVEN
        monkeypatch.setenv("UVICORN_PORT", "9001")
        monkeypatch.setenv("PORT", "10000")

        # WHEN
        settings = UvicornSettings()

        # THEN
        assert settings.PORT == 9001
