"""SQLAlchemy persistence model for the ``Account`` aggregate (ADR-122, ADR-123, ADR-134).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.account``. SQLAlchemy stays in the adapters
(AGENTS.md); the domain object remains plain Python. Column conventions mirror
``TransactionRecord``: UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC money
(ADR-025), server-managed timestamps, and a NOT NULL ``user_id`` ownership column
with no cross-schema FK to Supabase ``auth.users`` (ADR-094, ADR-130). The account
is a per-currency leaf under an institution (ADR-134): ``name`` and ``type`` moved
to ``InstitutionRecord`` and a NOT NULL ``institution_id`` FK was added.
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class AccountRecord(Base):
    """Relational mapping of an :class:`~margen_api.domain.models.account.Account`.

    ``opening_balance`` is stored as ``NUMERIC(18, 2)`` in the account's own
    ``currency`` (ADR-123) and may be negative (a card account opened with a
    balance). ``currency`` is a plain validated string (the value of the domain
    enum), consistent with how the transaction model stores ``currency`` (ADR-027).
    ``institution_id`` is a NOT NULL FK to ``institutions`` (ADR-134); deleting an
    institution cascades to its accounts. The derived balance is computed by the
    query side and is intentionally NOT a column (ADR-122).
    """

    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every account is owned, so it is NOT NULL. No
    # ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table (ADR-094). Indexed for the
    # owner-scoped reads (ADR-108/130).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    # The owning institution (ADR-134). NOT NULL: every account belongs to one
    # institution. ``ondelete=CASCADE`` so removing an institution removes its
    # currency leaves. A user may only reference one of their own institutions --
    # enforced at the application layer (ADR-130), not by the FK.
    institution_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("institutions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
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
