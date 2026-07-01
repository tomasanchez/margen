"""add transactions.offsets_transaction_id reimbursement offset link

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-07-01 10:00:00.000000

One additive, non-destructive column add for the reimbursement money model
(ADR-158, ADR-159):

* ``transactions.offsets_transaction_id`` (``UUID``, nullable, SELF-FK to
  ``transactions.id`` with ``ON DELETE SET NULL``) — for a ``kind='reimbursement'``
  row, the id of the EXPENSE the payback offsets (ADR-159). Populated only for
  reimbursement rows (the domain forces it NULL for every other kind); NULL
  everywhere else. Deleting the source expense orphans the payback rather than
  cascading (``SET NULL``). The target-exists / same-owner / is-expense checks are an
  application-layer concern (ADR-130); the FK guarantees only referential integrity.

A partial index ``WHERE kind = 'reimbursement'`` backs the net-spend join (ADR-160)
so it reads only the payback rows. The index predicate is PostgreSQL-specific and is
created with ``postgresql_where``.

The change is additive (nullable column, no NOT NULL, no data backfill), so CI
auto-migrate (ADR-118) is clean and no existing row is touched (going-forward
rollout, ADR-162). The ``downgrade`` drops the index then the column.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: str | Sequence[str] | None = "b3c4d5e6f7a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable self-FK offset link column, its FK constraint and partial index."""
    op.add_column("transactions", sa.Column("offsets_transaction_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_transactions_offsets_transaction_id_transactions",
        "transactions",
        "transactions",
        ["offsets_transaction_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_transactions_offsets_transaction_id",
        "transactions",
        ["offsets_transaction_id"],
        postgresql_where=sa.text("kind = 'reimbursement'"),
    )


def downgrade() -> None:
    """Drop the partial index, the FK constraint and the offset link column."""
    op.drop_index("ix_transactions_offsets_transaction_id", table_name="transactions")
    op.drop_constraint(
        "fk_transactions_offsets_transaction_id_transactions",
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "offsets_transaction_id")
