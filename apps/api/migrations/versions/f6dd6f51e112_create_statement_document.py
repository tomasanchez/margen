"""create statement_document

Revision ID: f6dd6f51e112
Revises: c89a49fe1c9f
Create Date: 2026-06-14 00:00:00.000000

Adds the ``statement_document`` side table (ADR-077): a 1:N store for the
uploaded credit-card statement PDF (``BYTEA``), its extracted text, and the
statement natural-key/metadata fields. Unlike the invoice 1:1 table (ADR-071),
the link lives on the many side: a nullable ``transactions.statement_document_id``
FK to ``statement_document.id`` with ``ON DELETE SET NULL`` (so deleting a
statement leaves its transactions intact). The natural-key index over
(``issuer_cuit``, ``card_last4``, ``statement_number``) is NOT unique because a
legitimate re-import must stay possible -- dedupe is advisory (ADR-077). Money
columns are ``NUMERIC`` (ADR-025). The downgrade drops the FK column, then the
index, then the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6dd6f51e112"
down_revision: str | Sequence[str] | None = "c89a49fe1c9f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create statement_document, its advisory index, and the transactions FK (ADR-077)."""
    op.create_table(
        "statement_document",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("pdf_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("bank_name", sa.String(length=100), nullable=True),
        sa.Column("network", sa.String(length=50), nullable=True),
        sa.Column("card_last4", sa.String(length=4), nullable=True),
        sa.Column("issuer_cuit", sa.String(length=20), nullable=True),
        sa.Column("statement_number", sa.String(length=50), nullable=True),
        sa.Column("period_close", sa.Date(), nullable=True),
        sa.Column("period_due", sa.Date(), nullable=True),
        sa.Column("total_amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # Advisory dedupe lookup on the statement natural key; NOT unique so a legitimate
    # re-import (partial correction, re-issued statement) stays possible (ADR-077).
    op.create_index(
        "ix_statement_document_natural_key",
        "statement_document",
        ["issuer_cuit", "card_last4", "statement_number"],
        unique=False,
    )
    # Link each imported expense back to its source statement (the many side);
    # nullable so manually-entered transactions are unaffected (ADR-077, ADR-028).
    op.add_column(
        "transactions",
        sa.Column("statement_document_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_transactions_statement_document_id_statement_document",
        "transactions",
        "statement_document",
        ["statement_document_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Drop the transactions FK column, then the statement_document index and table."""
    op.drop_constraint(
        "fk_transactions_statement_document_id_statement_document",
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "statement_document_id")
    op.drop_index("ix_statement_document_natural_key", table_name="statement_document")
    op.drop_table("statement_document")
