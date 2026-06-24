"""
Test suite for API Settings
"""

import pytest

from margen_api.settings.api_settings import ApplicationSettings, ContactInfo, LicenseInfo
from margen_api.version import __version__


class TestAPISettings:
    """
    Test suite for API Settings
    """

    def test_license_info_needs_valid_url(self):
        """
        GIVEN a LicenseInfo model
        WHEN the url is invalid
        THEN a ValueError is raised
        """
        with pytest.raises(ValueError):
            LicenseInfo(name="MIT", url="invalidURL")

    def test_contact_info_needs_valid_url_and_email(self):
        """
        GIVEN a ContactInfo model
        WHEN the url or email is invalid
        THEN a ValueError is raised
        """

        with pytest.raises(ValueError):
            ContactInfo(name="John Doe", url="https://example.com", email="invalidEmail")

        with pytest.raises(ValueError):
            ContactInfo(name="John Doe", url="invalidURL", email="john@doe.mail")

    def test_api_default_values(self):
        """
        Test API default values
        """
        settings = ApplicationSettings()

        assert settings.DEBUG is False
        assert settings.PROJECT_NAME == "Margen API"
        assert settings.PROJECT_DESCRIPTION == "Margen backend API"
        assert isinstance(settings.PROJECT_LICENSE, LicenseInfo)
        assert isinstance(settings.PROJECT_CONTACT, ContactInfo)
        assert settings.PROJECT_CONTACT.name == "Tomas Sanchez"
        assert __version__ == settings.VERSION

    def test_cors_origins_default_to_safe_allow_list(self):
        """
        GIVEN the application settings
        WHEN no CORS override is provided
        THEN the default origins are an explicit localhost allow-list, not a wildcard
        """
        settings = ApplicationSettings()

        assert settings.BACKEND_CORS_ORIGINS
        assert "*" not in settings.BACKEND_CORS_ORIGINS

    def test_cors_origins_parse_single_comma_separated_value(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a bare (unquoted) CORS origin in the environment
        WHEN the settings are loaded under a dotenv-style value
        THEN the origin is parsed into a single-item list
        """
        # GIVEN
        monkeypatch.setenv("FASTAPI_BACKEND_CORS_ORIGINS", "http://localhost:5173")

        # WHEN
        settings = ApplicationSettings()

        # THEN
        assert settings.BACKEND_CORS_ORIGINS == ["http://localhost:5173"]

    def test_cors_origins_parse_multiple_comma_separated_values_with_spaces(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN multiple comma-separated origins with surrounding whitespace and empties
        WHEN the settings are loaded
        THEN each origin is trimmed and empty tokens are dropped
        """
        # GIVEN
        monkeypatch.setenv(
            "FASTAPI_BACKEND_CORS_ORIGINS",
            " http://localhost:5173 , https://app.example.com , ",
        )

        # WHEN
        settings = ApplicationSettings()

        # THEN
        assert settings.BACKEND_CORS_ORIGINS == [
            "http://localhost:5173",
            "https://app.example.com",
        ]

    def test_cors_origins_parse_json_array_string_back_compat(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a JSON-array string (the historical format)
        WHEN the settings are loaded
        THEN the array is JSON-decoded into a list (back-compatibility preserved)
        """
        # GIVEN
        monkeypatch.setenv(
            "FASTAPI_BACKEND_CORS_ORIGINS",
            '["http://localhost:5173", "https://app.example.com"]',
        )

        # WHEN
        settings = ApplicationSettings()

        # THEN
        assert settings.BACKEND_CORS_ORIGINS == [
            "http://localhost:5173",
            "https://app.example.com",
        ]

    def test_cors_origins_accept_list_unchanged(self):
        """
        GIVEN a list passed programmatically
        WHEN the settings are constructed
        THEN the list is used unchanged
        """
        # GIVEN / WHEN
        settings = ApplicationSettings(BACKEND_CORS_ORIGINS=["https://app.example.com"])

        # THEN
        assert settings.BACKEND_CORS_ORIGINS == ["https://app.example.com"]

    def test_cors_origins_non_str_non_list_passes_through(self):
        """
        GIVEN a value that is neither a list nor a string
        WHEN the validator runs
        THEN it is returned unchanged for pydantic to reject downstream
        """
        # GIVEN / WHEN / THEN
        assert ApplicationSettings._parse_cors_origins(123) == 123
