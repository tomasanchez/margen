"""SQLAlchemy persistence model for the ``Transfer`` aggregate (ADR-135, ADR-130).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.transfer``. SQLAlchemy stays in the adapters (AGENTS.md);
the domain object remains plain Python. Column conventions mirror ``AccountRecord``:
UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC money (ADR-025), server-managed
timestamps, and a NOT NULL ``user_id`` ownership column with no cross-schema FK to
Supabase ``auth.users`` (ADR-094, ADR-130). Both account FKs use ``ondelete=CASCADE``
so removing an account removes its transfers, mirroring how an institution cascades
to its accounts (ADR-134) and keeping the balance ledger free of dangling rows.
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class TransferRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.transfer.Transfer`.

    ``amount_out`` and ``amount_in`` are stored as ``NUMERIC(18, 2)`` in their
    respective account's native currency (ADR-123, ADR-025); for a same-currency
    transfer they are equal. ``from_account_id`` and ``to_account_id`` are NOT NULL
    FKs to ``accounts`` with ``ondelete=CASCADE``. A transfer must always move money
    between two of the caller's own accounts — enforced at the application layer
    (ADR-130), not by the FK. The balance ledger reads these rows directly; there is
    no derived column.
    """

    __tablename__ = "transfers"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every transfer is owned, so it is NOT NULL. No
    # ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table (ADR-094). Indexed for the
    # owner-scoped reads (ADR-108/130).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    from_account_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    to_account_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    amount_out: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    amount_in: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    occurred_on: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
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
