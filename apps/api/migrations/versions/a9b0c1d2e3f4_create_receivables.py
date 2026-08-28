"""create receivables tables: person, receivable_item, receivable_payment, receivable_allocation (ADR-204)

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-08-28 12:00:00.000000

Creates the four receivables tables backing the money-owed-to-the-owner feature
(ADR-203/204) — the conceptual inverse of the ``debts`` table (ADR-187). They mirror the
existing ``DebtRecord`` / ``TransactionRecord`` conventions: UUID pk via
``gen_random_uuid`` (ADR-026), NUMERIC(18,2) ARS money (ADR-025/034), server-managed
timestamps, and a NOT NULL ``user_id`` ownership column on the root ``person`` table with
NO cross-schema FK to Supabase ``auth.users`` (ADR-094, ADR-130); child rows inherit
ownership through ``person_id`` rather than carrying their own ``user_id``.

Crucially, **no table carries an ``account_id``** — receivables are structurally excluded
from balance and net-worth aggregation (ADR-205), so there is no join path from these
rows into ``account_queries.py``. The only FK leaving the receivables subsystem is
``receivable_payment.matched_income_transaction_id`` → ``transactions.id`` (a confirmed
income match, ADR-207) with ``ON DELETE SET NULL`` so deleting the income orphans the
payback rather than cascading a settlement record away. ``person`` → items/payments and
payment/item → allocations use ``ON DELETE CASCADE`` so deleting a person tears down the
whole subtree (ADR-208). Standard indexes back the owner scope and every FK
(``person_id`` / ``payment_id`` / ``item_id``); ``matched_income_transaction_id`` is backed
by a PARTIAL UNIQUE index (``WHERE ... IS NOT NULL``) that enforces the ADR-207 "claimed"
invariant at the database — an income backs at most one payment — as defense-in-depth behind
the handler's check, while still allowing unlimited NULL (manual) paybacks (ADR-204).

No data migration is involved — four brand-new tables. The ``downgrade`` drops them in
FK-dependency order (allocations, then payments and items, then person).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9b0c1d2e3f4"
down_revision: str | Sequence[str] | None = "f8a9b0c1d2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the four receivables tables with owner scope, FKs, cascades and indexes (ADR-204)."""
    op.create_table(
        "person",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_person_user_id", "person", ["user_id"])

    op.create_table(
        "receivable_item",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("person_id", sa.Uuid(), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["person_id"],
            ["person.id"],
            name="fk_receivable_item_person_id_person",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_receivable_item_person_id", "receivable_item", ["person_id"])

    op.create_table(
        "receivable_payment",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("person_id", sa.Uuid(), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("matched_income_transaction_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["person_id"],
            ["person.id"],
            name="fk_receivable_payment_person_id_person",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["matched_income_transaction_id"],
            ["transactions.id"],
            name="fk_receivable_payment_matched_income_transaction",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_receivable_payment_person_id", "receivable_payment", ["person_id"])
    # Partial UNIQUE index: a confirmed income is "claimed" and may back at most one payment
    # (ADR-207). This is defense-in-depth behind the handler's claimed check — it also serves
    # as the FK-supporting lookup index for ``matched_income_transaction_id``. The NULL filter
    # lets unlimited manual paybacks (which carry no matched income) coexist.
    op.create_index(
        "uq_receivable_payment_matched_income_transaction_id",
        "receivable_payment",
        ["matched_income_transaction_id"],
        unique=True,
        postgresql_where=sa.text("matched_income_transaction_id IS NOT NULL"),
    )

    op.create_table(
        "receivable_allocation",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("payment_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["receivable_payment.id"],
            name="fk_receivable_allocation_payment_id_receivable_payment",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["receivable_item.id"],
            name="fk_receivable_allocation_item_id_receivable_item",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_receivable_allocation_payment_id", "receivable_allocation", ["payment_id"])
    op.create_index("ix_receivable_allocation_item_id", "receivable_allocation", ["item_id"])


def downgrade() -> None:
    """Drop the four receivables tables in FK-dependency order (allocations first)."""
    op.drop_index("ix_receivable_allocation_item_id", table_name="receivable_allocation")
    op.drop_index("ix_receivable_allocation_payment_id", table_name="receivable_allocation")
    op.drop_table("receivable_allocation")

    op.drop_index("uq_receivable_payment_matched_income_transaction_id", table_name="receivable_payment")
    op.drop_index("ix_receivable_payment_person_id", table_name="receivable_payment")
    op.drop_table("receivable_payment")

    op.drop_index("ix_receivable_item_person_id", table_name="receivable_item")
    op.drop_table("receivable_item")

    op.drop_index("ix_person_user_id", table_name="person")
    op.drop_table("person")
