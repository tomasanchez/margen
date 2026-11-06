"""create receivable_installment; add allocation.installment_id + item.source_transaction_id (ADR-214/217/221)

Revision ID: c1d2e3f4a5b6
Revises: b0c1d2e3f4a5
Create Date: 2026-11-06 12:00:00.000000

Three additive, non-destructive schema changes backing receivable installment schedules
(cuotas) and the optional item → expense reference link:

* ``receivable_installment`` (new table, ADR-214) — one row per cuota of an item repaid in
  installments: ``item_id`` FK → ``receivable_item.id`` ``ON DELETE CASCADE`` (deleting an
  item, or transitively its person, removes the schedule, ADR-208), the 1-based ``index``,
  ``due_on``, NUMERIC(18,2) ARS ``amount`` (ADR-025), the cuota-grain ``pardoned_at``
  (ADR-210/221) and a server-managed ``created_at``. ``UNIQUE (item_id, index)`` keeps cuota
  numbers distinct within a plan; its btree leads with ``item_id``, so it also serves as the
  FK/lookup index and no separate single-column ``item_id`` index is created. Ownership flows
  through the item → person (ADR-130); no ``account_id`` (ADR-205).
* ``receivable_allocation.installment_id`` (nullable, ADR-221) — FK →
  ``receivable_installment.id`` ``ON DELETE CASCADE`` (an allocation to a deleted cuota goes
  with it), indexed. Existing allocations stay item-level with ``installment_id`` NULL — no
  backfill (ADR-223). "Required iff the item has a schedule" is an application-layer
  invariant; no portable cross-table CHECK can express it (ADR-223).
* ``receivable_item.source_transaction_id`` (nullable, ADR-217) — FK → ``transactions.id``
  ``ON DELETE SET NULL`` (deleting the expense drops only the reference, never the debt,
  ADR-223), indexed, and deliberately NOT unique: one shared expense may back many items
  (ADR-218). Reference-only — it never nets anything out of net worth, budgets or category
  spend, and is distinct from ``transactions.offsets_transaction_id`` (ADR-219).

Every change is additive (a new table plus nullable columns with no default and no
backfill), so existing rows stay valid and CI auto-migrate (ADR-118) is clean. Lock
footprint is brief: the column adds are catalog-only, and each new FK validates a table
whose new column is entirely NULL. The ``downgrade`` reverses each step in FK-dependency
order. It is lossy only for the new data — cuota schedules and expense links are dropped —
while every allocation keeps its NOT NULL ``item_id`` and so survives as an item-level
allocation.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: str | Sequence[str] | None = "b0c1d2e3f4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the cuota table, then add the two nullable link columns with FKs and indexes."""
    op.create_table(
        "receivable_installment",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("index", sa.Integer(), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("pardoned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["receivable_item.id"],
            name="fk_receivable_installment_item_id_receivable_item",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        # One cuota number per plan; the backing btree (item_id, index) doubles as the
        # item_id FK/lookup index, so no separate ix_receivable_installment_item_id.
        sa.UniqueConstraint("item_id", "index", name="uq_receivable_installment_item_id_index"),
    )

    op.add_column("receivable_allocation", sa.Column("installment_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_receivable_allocation_installment_id_receivable_installment",
        "receivable_allocation",
        "receivable_installment",
        ["installment_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_receivable_allocation_installment_id", "receivable_allocation", ["installment_id"])

    op.add_column("receivable_item", sa.Column("source_transaction_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_receivable_item_source_transaction_id_transactions",
        "receivable_item",
        "transactions",
        ["source_transaction_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_receivable_item_source_transaction_id", "receivable_item", ["source_transaction_id"])


def downgrade() -> None:
    """Drop each link (index, FK, column), then the cuota table, in FK-dependency order."""
    op.drop_index("ix_receivable_item_source_transaction_id", table_name="receivable_item")
    op.drop_constraint(
        "fk_receivable_item_source_transaction_id_transactions",
        "receivable_item",
        type_="foreignkey",
    )
    op.drop_column("receivable_item", "source_transaction_id")

    op.drop_index("ix_receivable_allocation_installment_id", table_name="receivable_allocation")
    op.drop_constraint(
        "fk_receivable_allocation_installment_id_receivable_installment",
        "receivable_allocation",
        type_="foreignkey",
    )
    op.drop_column("receivable_allocation", "installment_id")

    op.drop_table("receivable_installment")
