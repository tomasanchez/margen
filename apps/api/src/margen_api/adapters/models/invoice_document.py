"""SQLAlchemy persistence model for a stored ARCA invoice document (ADR-071).

A 1:1 side table to the ``transactions`` aggregate that retains the original
uploaded PDF (``BYTEA``), its extracted text and QR ``JSONB`` for a future
no-reparse semantic search, and the invoice natural-key fields used by the
advisory dedupe check. Keeping the blob and import metadata off the transaction
aggregate keeps that aggregate lean (ADR-071). Money columns are ``NUMERIC``
(ADR-025); timestamps are server-managed like ``TransactionRecord``. The PDF is
reached only through the ``DocumentStore`` port so a later Azure Blob adapter is
a drop-in (ADR-071, ADR-073).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base

# Portable JSON column type: real ``JSONB`` on PostgreSQL (the production target,
# ADR-018) and generic ``JSON`` on other dialects so the offline SQLite test tier
# (ADR-019/032) can create the schema without a Postgres-only DDL type.
_JSON_DOCUMENT = JSON().with_variant(JSONB(), "postgresql")


class InvoiceDocumentRecord(Base):
    """Relational mapping of a stored invoice PDF and its import metadata (ADR-071).

    ``transaction_id`` is a ``UNIQUE`` FK enforcing the 1:1 relationship with a
    transaction (``ON DELETE CASCADE`` so removing a transaction drops its
    document). The natural-key tuple ``(emisor_cuit, pto_vta, tipo_cmp, nro_cmp)``
    is indexed but deliberately **not unique**: a legitimate re-import must remain
    possible, so dedupe is advisory (warn, not block — ADR-071). All natural-key
    and record fields are nullable because text-only or malformed invoices may not
    yield every field.
    """

    __tablename__ = "invoice_document"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-094): every write path now sets it, so it is NOT NULL
    # (ADR-109; enforced in PROD only after the backfill script fills legacy NULLs).
    # No ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table, so a cross-schema FK would break
    # both migrations and tests. Indexed for the owner-scoped reads (ADR-107/108).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    pdf_bytes: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer(), nullable=False)
    extracted_text: Mapped[str | None] = mapped_column(Text(), nullable=True)
    qr_json: Mapped[dict | None] = mapped_column(_JSON_DOCUMENT, nullable=True)
    emisor_cuit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    pto_vta: Mapped[str | None] = mapped_column(String(10), nullable=True)
    tipo_cmp: Mapped[str | None] = mapped_column(String(10), nullable=True)
    nro_cmp: Mapped[str | None] = mapped_column(String(20), nullable=True)
    cae: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fecha: Mapped[datetime.date | None] = mapped_column(Date(), nullable=True)
    importe: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    moneda: Mapped[str | None] = mapped_column(String(3), nullable=True)
    ctz: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
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

    __table_args__ = (
        # Advisory dedupe lookup on the invoice natural key; NOT unique so a
        # legitimate re-import (corrected amount, re-issued invoice) stays possible
        # (ADR-071).
        Index(
            "ix_invoice_document_natural_key",
            "emisor_cuit",
            "pto_vta",
            "tipo_cmp",
            "nro_cmp",
        ),
    )
