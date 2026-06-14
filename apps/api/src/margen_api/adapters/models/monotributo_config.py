"""SQLAlchemy persistence model for the single-row Monotributo config.

Stores the user's currently configured Monotributo category and activity type so
the trailing-12-month calculation (ADR-046) can look up the annual ceiling. There
is no auth/multi-user yet (ADR-048), so this is a single-row table with no
per-user key. Column conventions mirror ``TransactionRecord`` (UUID pk via
``gen_random_uuid``, server-managed timestamps).
"""

from __future__ import annotations

import datetime
import uuid

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class MonotributoConfigRecord(Base):
    """Relational mapping of the single-row Monotributo configuration (ADR-048).

    ``current_category`` is a category letter A-K (see
    ``margen_api.domain.models.monotributo_scale``). ``activity_type`` is a plain
    validated string defaulting to ``"services"`` -- the MVP path.
    """

    __tablename__ = "monotributo_config"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    current_category: Mapped[str] = mapped_column(String(2), nullable=False)
    activity_type: Mapped[str] = mapped_column(
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
