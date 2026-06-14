"""create invoice_document

Revision ID: c89a49fe1c9f
Revises: cde5505de5cd
Create Date: 2026-06-14 00:00:00.000000

Adds the ``invoice_document`` side table (ADR-071): a 1:1 store for the uploaded
ARCA invoice PDF (``BYTEA``), its extracted text and QR ``JSONB``, and the
invoice natural-key fields. ``transaction_id`` is a ``UNIQUE`` FK to
``transactions`` with ``ON DELETE CASCADE`` (1:1). The natural-key index is NOT
unique because a legitimate re-import must stay possible -- dedupe is advisory
(ADR-071). Money columns are ``NUMERIC`` (ADR-025). The downgrade drops the
table (and with it the index and FK).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c89a49fe1c9f"
down_revision: str | Sequence[str] | None = "cde5505de5cd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create invoice_document with the FK and advisory natural-key index (ADR-071)."""
    op.create_table(
        "invoice_document",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("transaction_id", sa.UUID(), nullable=False),
        sa.Column("pdf_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("qr_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("emisor_cuit", sa.String(length=20), nullable=True),
        sa.Column("pto_vta", sa.String(length=10), nullable=True),
        sa.Column("tipo_cmp", sa.String(length=10), nullable=True),
        sa.Column("nro_cmp", sa.String(length=20), nullable=True),
        sa.Column("cae", sa.String(length=20), nullable=True),
        sa.Column("fecha", sa.Date(), nullable=True),
        sa.Column("importe", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("moneda", sa.String(length=3), nullable=True),
        sa.Column("ctz", sa.Numeric(precision=18, scale=6), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name="fk_invoice_document_transaction_id_transactions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("transaction_id", name="uq_invoice_document_transaction_id"),
    )
    # Advisory dedupe lookup on the invoice natural key; NOT unique so a legitimate
    # re-import (corrected amount, re-issued invoice) stays possible (ADR-071).
    op.create_index(
        "ix_invoice_document_natural_key",
        "invoice_document",
        ["emisor_cuit", "pto_vta", "tipo_cmp", "nro_cmp"],
        unique=False,
    )


def downgrade() -> None:
    """Drop invoice_document (and with it its index and FK)."""
    op.drop_index("ix_invoice_document_natural_key", table_name="invoice_document")
    op.drop_table("invoice_document")
