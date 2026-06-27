"""SQLAlchemy persistence model for the ``Account`` aggregate (ADR-122, ADR-123).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.account``. SQLAlchemy stays in the adapters
(AGENTS.md); the domain object remains plain Python. Column conventions mirror
``TransactionRecord``: UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC money
(ADR-025), server-managed timestamps, and a NOT NULL ``user_id`` ownership column
with no cross-schema FK to Supabase ``auth.users`` (ADR-094, ADR-130).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class AccountRecord(Base):
    """Relational mapping of an :class:`~margen_api.domain.models.account.Account`.

    ``opening_balance`` is stored as ``NUMERIC(18, 2)`` in the account's own
    ``currency`` (ADR-123) and may be negative (a card account opened with a
    balance). ``type`` and ``currency`` are plain validated strings (the values of
    the domain enums), consistent with how the transaction model stores ``kind`` /
    ``currency`` (ADR-027). The derived balance is computed by the query side and
    is intentionally NOT a column (ADR-122).
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
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
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
