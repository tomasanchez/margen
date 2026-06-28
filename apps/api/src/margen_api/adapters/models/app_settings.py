"""SQLAlchemy persistence model for the per-user application settings.

Consolidates each user's preferences into one row (ADR-054, ADR-110): the
preferred display currency, the default FX rate type, and the Monotributo
category / activity type that previously lived in ``monotributo_config``
(ADR-048, now superseded). The table holds one row per user, keyed by the
``user_id`` ownership column with a ``UNIQUE`` constraint (ADR-110); the row is
lazily get-or-created on first write. Column conventions mirror
``TransactionRecord`` (UUID pk via ``gen_random_uuid``, server-managed
timestamps).

Currency and FX-default values are validated in the domain layer (ADR-054),
consistent with the ``FxRateType`` string pattern (ADR-044), so they are plain
string columns rather than DB-level enums.
"""

from __future__ import annotations

import datetime
import uuid

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint, false, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class AppSettingsRecord(Base):
    """Relational mapping of the per-user application settings (ADR-054, ADR-110).

    ``preferred_display_currency`` is a 3-letter currency code (e.g. ``"ARS"``)
    and ``fx_default_rate_type`` is an FX rate-type token (e.g. ``"MEP"``); both
    are validated in the domain layer. ``monotributo_current_category`` is a
    category letter A-K and ``monotributo_activity_type`` defaults to
    ``"services"`` -- carried over from the retired ``monotributo_config`` table.
    ``monotributo_enabled`` gates the optional Monotributo module per user
    (ADR-126); it defaults to ``False`` for brand-new rows. ``user_id`` is unique
    so each user owns exactly one settings row (ADR-110).
    """

    __tablename__ = "app_settings"
    __table_args__ = (UniqueConstraint("user_id", name="uq_app_settings_user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Per-user ownership key (ADR-110): one settings row per user, enforced by the
    # ``UNIQUE`` constraint above and indexed for the owner-scoped reads. Now NOT
    # NULL (ADR-109; enforced in PROD only after the backfill script assigns the
    # legacy single row to the owner) with no ForeignKey -- auth users live in
    # Supabase's ``auth.users`` schema and the hermetic SQLite e2e tier has no such
    # table, so a cross-schema FK would break both migrations and tests.
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
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
    # Per-user toggle for the optional Monotributo module (ADR-126). Brand-new rows
    # default to ``False`` (Monotributo hidden); the data migration back-fills
    # existing rows to ``True`` so current users keep their access. Gates only the
    # UI -- the M2M capture endpoint (ADR-064) is unaffected.
    monotributo_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=false(),
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
