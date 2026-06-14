"""Reader port for the application settings query side (ADR-054).

The reader serves the settings surface: the preferred display currency, the
default FX rate type, and the Monotributo category / activity type. It is
strictly read-only -- settings writes go through a command on the unit of work
(ADR-054), never through this port. The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.settings_read_models import AppSettings


class AbstractSettingsReader(ABC):
    """Async, read-only query port for the application settings (ADR-054)."""

    @abstractmethod
    async def get_settings(self) -> AppSettings:
        """Return the current application settings (ADR-054).

        Reads the single ``app_settings`` row and projects it into an
        :class:`AppSettings` read model. When no row exists yet the adapter
        supplies the documented defaults (ARS / MEP / category ``C`` / services)
        so the query side never returns ``None``.

        Returns:
            The current :class:`AppSettings`.
        """
