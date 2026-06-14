"""SQLAlchemy persistence model for a stored credit-card statement document (ADR-077).

A 1:N parent of the ``transactions`` aggregate that retains the original uploaded
statement PDF (``BYTEA``), its extracted text for reference/audit, and the
statement natural-key fields used by the advisory dedupe check. Each imported
expense links back through ``transactions.statement_document_id`` (ADR-077).
Keeping the blob and import metadata off the transaction aggregate keeps that
aggregate lean (ADR-028). Money columns are ``NUMERIC`` (ADR-025); timestamps are
server-managed like ``TransactionRecord``. The PDF is reached only through the
``StatementStore`` port so a later Azure Blob adapter is a drop-in (ADR-077).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class StatementDocumentRecord(Base):
    """Relational mapping of a stored statement PDF and its import metadata (ADR-077).

    One statement document backs many transactions (1:N), unlike the invoice 1:1
    table (ADR-071): the link lives on the ``transactions.statement_document_id``
    FK (the many side), so this table carries no ``transaction_id``. The natural-key
    tuple ``(issuer_cuit, card_last4, statement_number)`` is indexed but
    deliberately **not unique**: a legitimate re-import must remain possible, so
    dedupe is advisory (warn, not block — ADR-077). Natural-key and metadata fields
    are nullable because a malformed statement may not yield every field.
    """

    __tablename__ = "statement_document"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    pdf_bytes: Mapped[bytes] = mapped_column(LargeBinary(), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer(), nullable=False)
    extracted_text: Mapped[str | None] = mapped_column(Text(), nullable=True)
    bank_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    network: Mapped[str | None] = mapped_column(String(50), nullable=True)
    card_last4: Mapped[str | None] = mapped_column(String(4), nullable=True)
    issuer_cuit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    statement_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    period_close: Mapped[datetime.date | None] = mapped_column(Date(), nullable=True)
    period_due: Mapped[datetime.date | None] = mapped_column(Date(), nullable=True)
    total_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
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
        # Advisory dedupe lookup on the statement natural key; NOT unique so a
        # legitimate re-import (partial correction, re-issued statement) stays
        # possible (ADR-077).
        Index(
            "ix_statement_document_natural_key",
            "issuer_cuit",
            "card_last4",
            "statement_number",
        ),
    )
