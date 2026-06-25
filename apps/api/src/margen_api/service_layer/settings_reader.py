"""Reader port for the application settings query side (ADR-054, ADR-110).

The reader serves the settings surface: the preferred display currency, the
default FX rate type, and the Monotributo category / activity type, scoped to the
authenticated owner (ADR-110). It is strictly read-only -- settings writes go
through a command on the unit of work (ADR-054), never through this port. The
concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.settings_read_models import AppSettings


class AbstractSettingsReader(ABC):
    """Async, read-only query port for the per-user application settings (ADR-054, ADR-110)."""

    @abstractmethod
    async def get_settings(self, user_id: str) -> AppSettings:
        """Return the owner's application settings (ADR-054, ADR-110).

        Reads the owner's ``app_settings`` row and projects it into an
        :class:`AppSettings` read model. When the owner has no row yet the adapter
        supplies the documented defaults (ARS / MEP / category ``C`` / services)
        so the query side never returns ``None``.

        Args:
            user_id: The authenticated owner whose settings row is read. The
                read is scoped to this user so a caller only sees their own
                preferences (ADR-108, ADR-110).

        Returns:
            The owner's current :class:`AppSettings`.
        """
