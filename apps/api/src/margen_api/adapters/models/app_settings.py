"""SQLAlchemy persistence model for the single-row application settings.

Consolidates the user's preferences into one table (ADR-054): the preferred
display currency, the default FX rate type, and the Monotributo category /
activity type that previously lived in ``monotributo_config`` (ADR-048, now
superseded). There is no auth/multi-user yet, so this is a single-row table with
no per-user key. Column conventions mirror ``TransactionRecord`` (UUID pk via
``gen_random_uuid``, server-managed timestamps).

Currency and FX-default values are validated in the domain layer (ADR-054),
consistent with the ``FxRateType`` string pattern (ADR-044), so they are plain
string columns rather than DB-level enums.
"""

from __future__ import annotations

import datetime
import uuid

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class AppSettingsRecord(Base):
    """Relational mapping of the single-row application settings (ADR-054).

    ``preferred_display_currency`` is a 3-letter currency code (e.g. ``"ARS"``)
    and ``fx_default_rate_type`` is an FX rate-type token (e.g. ``"MEP"``); both
    are validated in the domain layer. ``monotributo_current_category`` is a
    category letter A-K and ``monotributo_activity_type`` defaults to
    ``"services"`` -- carried over from the retired ``monotributo_config`` table.
    """

    __tablename__ = "app_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Forward-compat ownership column (ADR-094): nullable, unused, no enforcement
    # yet. No ForeignKey -- auth users live in Supabase's ``auth.users`` schema and
    # the hermetic SQLite e2e tier has no such table, so a cross-schema FK would
    # break both migrations and tests. The deferred backfill (ADR-090) sets this.
    user_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)
    preferred_display_currency: Mapped[str] = mapped_column(
        String(3),
        nullable=False,
        server_default="ARS",
    )
    fx_default_rate_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="MEP",
    )
    monotributo_current_category: Mapped[str] = mapped_column(
        String(2),
        nullable=False,
    )
    monotributo_activity_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="services",
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
