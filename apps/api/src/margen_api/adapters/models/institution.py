"""SQLAlchemy persistence model for the ``Institution`` aggregate (ADR-130, ADR-134).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.institution``. SQLAlchemy stays in the adapters
(AGENTS.md); the domain object remains plain Python. Column conventions mirror
``AccountRecord``: UUID pk via ``gen_random_uuid`` (ADR-026), server-managed
timestamps, and a NOT NULL ``user_id`` ownership column with no cross-schema FK to
Supabase ``auth.users`` (ADR-094, ADR-130).
"""

from __future__ import annotations

import datetime
import uuid

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class InstitutionRecord(Base):
    """Relational mapping of an :class:`~margen_api.domain.models.institution.Institution`.

    ``type`` is a plain validated string (the value of the domain enum), consistent
    with how the account/transaction models store their validated strings (ADR-027).
    Currency-specific balances live on child ``accounts`` rows (ADR-134); this table
    holds no balance.
    """

    __tablename__ = "institutions"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every institution is owned, so it is NOT NULL. No
    # ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table (ADR-094). Indexed for the
    # owner-scoped reads (ADR-108/130).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    # Card identity (ADR-190): a physical card is a CARD institution identified by its
    # network brand + printed last-4. Nullable so bank / cash / wallet institutions are
    # unaffected (no backfill). Stored as ``card_brand`` / ``card_last4`` columns; the
    # domain field names are ``brand`` / ``last4`` (mapper translates).
    card_brand: Mapped[str | None] = mapped_column(String(50), nullable=True)
    card_last4: Mapped[str | None] = mapped_column(String(4), nullable=True)
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
