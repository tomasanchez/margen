"""create accounts table, add transactions.account_id, seed from bank tags

Revision ID: f7a8b9c0d1e2
Revises: e5f6a7b8c9d0
Create Date: 2026-06-27 12:00:00.000000

Introduces the ``Account`` aggregate (ADR-122) and links transactions to it
(ADR-122, ADR-124):

1. Creates the ``accounts`` table (UUID pk, owner ``user_id``, name, type,
   currency, opening_balance, timestamps) — mirroring ``AccountRecord``.
2. Adds the nullable ``transactions.account_id`` FK (``ondelete=SET NULL``) and
   indexes it for the owner-scoped balance aggregation.
3. **In-place backfill** (ADR-124): for each distinct existing ``payment_method``
   (the normalized bank, ADR-117) per ``user_id``, INSERTs one account
   (``name`` = the bank string, ``opening_balance`` = 0, ``currency`` = 'ARS') and
   UPDATEs that user's transactions carrying the bank to point ``account_id`` at
   the new account. The account ``type`` is decided by :func:`account_type_for`:
   ``card`` when any of the user's transactions with that bank carries a non-null
   ``card`` detail (a historical credit-card import, ADR-117), otherwise ``bank``.
   ``cash`` is not auto-seeded — cash accounts are user-created later (ADR-122).

``account_id`` is left **nullable**: transactions with no ``payment_method``
(``NULL``) have no bank to seed from and stay unlinked, and the hermetic SQLite
e2e tier creates rows with no account. This intentionally relaxes ADR-124 step 5
("set account_id NOT NULL after backfill"): a hard NOT NULL would reject every
legitimately bank-less row and break the e2e tier. The link is enforced at the
application layer instead (a transaction may only reference its owner's account,
ADR-130).

The backfill runs row-set by row-set through the bind connection with parameter-
bound statements so it is portable across PostgreSQL / Supabase (the production
target) and the in-memory SQLite the e2e tier uses. Creating the table and adding
the column are SQLite-compatible.

This migration **rewrites existing prod rows** (it links every bank-tagged
transaction to a seeded account), so it MUST be applied to Supabase via the CI
migrate job (ADR-118) — ``cd apps/api && uv run --env-file .env alembic upgrade
head`` — only **after** a Supabase backup is taken (risk recorded in ADR-132). It
follows the one-way data-rewrite precedent of ADR-117 / ADR-124.

The ``downgrade`` drops ``transactions.account_id`` and the ``accounts`` table
(the seeded accounts and the links are discarded).
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: str | Sequence[str] | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Seeded accounts are ARS by default (ADR-124): the migration cannot infer a
# native currency from a bank tag, and historical amounts are ARS-authoritative
# (ADR-025); the user re-currencies a USD account afterward (ADR-123).
_SEED_CURRENCY = "ARS"
# Opening balance 0 so each seeded account's net balance equals the sum of its
# existing transactions; the user sets a real opening balance later (ADR-124).
_SEED_OPENING_BALANCE = "0"


def account_type_for(*, has_card_detail: bool) -> str:
    """Decide a seeded account's ``type`` from whether the bank had card detail (ADR-124).

    Pure, deterministic helper backing the backfill so the rule is unit-testable in
    isolation (no DB needed). A bank that historically carried card detail on any of
    the user's transactions (e.g. an imported ``VISA ·5771`` label, ADR-117) seeds a
    ``card`` account; otherwise it seeds a plain ``bank`` account. ``cash`` is never
    auto-seeded — cash accounts are user-created (ADR-122).

    Args:
        has_card_detail: Whether any of the user's transactions for this bank carries
            a non-null ``card`` value.

    Returns:
        ``"card"`` when the bank had card detail, otherwise ``"bank"``.
    """
    return "card" if has_card_detail else "bank"


def upgrade() -> None:
    """Create ``accounts``, add ``transactions.account_id``, and backfill from bank tags."""
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("opening_balance", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_accounts_user_id", "accounts", ["user_id"])

    op.add_column("transactions", sa.Column("account_id", sa.Uuid(), nullable=True))
    op.create_index("ix_transactions_account_id", "transactions", ["account_id"])
    op.create_foreign_key(
        "fk_transactions_account_id_accounts",
        "transactions",
        "accounts",
        ["account_id"],
        ["id"],
        ondelete="SET NULL",
    )

    _backfill_accounts_from_bank_tags()


def _backfill_accounts_from_bank_tags() -> None:
    """Seed one account per distinct ``(user_id, payment_method)`` and link transactions.

    Portable, parameter-bound SQL so the same path runs on PostgreSQL / Supabase
    and the SQLite e2e tier (ADR-124). For each distinct bank tag per owner it
    decides the account ``type`` from whether any of that owner's transactions for
    the bank carries a ``card`` detail (ADR-117), inserts the account with a
    generated UUID, and links the matching transactions.
    """
    bind = op.get_bind()
    # Distinct (owner, bank) pairs, plus whether the bank ever carried a card detail
    # for that owner (drives the bank-vs-card type rule). Grouped server-side so the
    # set is small even on large tables.
    pairs = bind.execute(
        sa.text(
            "SELECT user_id, payment_method, "
            "MAX(CASE WHEN card IS NOT NULL THEN 1 ELSE 0 END) AS has_card "
            "FROM transactions WHERE payment_method IS NOT NULL "
            "GROUP BY user_id, payment_method"
        )
    ).fetchall()

    insert_account = sa.text(
        "INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, created_at, updated_at) "
        "VALUES (:id, :user_id, :name, :type, :currency, :opening_balance, :now, :now)"
    )
    link_transactions = sa.text(
        "UPDATE transactions SET account_id = :account_id WHERE user_id = :user_id AND payment_method = :payment_method"
    )
    # A concrete timestamp bound as a parameter — a SQL function expression cannot be
    # a bound value under asyncpg, and a Python datetime round-trips on both
    # PostgreSQL and the SQLite e2e tier.
    now = datetime.now(UTC)
    for row in pairs:
        account_id = _new_uuid(bind)
        account_type = account_type_for(has_card_detail=bool(row.has_card))
        bind.execute(
            insert_account,
            {
                "id": account_id,
                "user_id": row.user_id,
                "name": row.payment_method,
                "type": account_type,
                "currency": _SEED_CURRENCY,
                "opening_balance": _SEED_OPENING_BALANCE,
                "now": now,
            },
        )
        bind.execute(
            link_transactions,
            {
                "account_id": account_id,
                "user_id": row.user_id,
                "payment_method": row.payment_method,
            },
        )


def _new_uuid(bind: sa.engine.Connection) -> str:
    """Return a fresh UUID string, generated DB-side for dialect portability.

    PostgreSQL provides ``gen_random_uuid()``; SQLite does not, so the e2e tier
    falls back to a Python UUID. Generating the id explicitly (rather than relying
    on the column default) lets the same INSERT also drive the ``UPDATE`` that links
    the transactions to the new account.
    """
    if bind.dialect.name == "postgresql":
        return str(bind.execute(sa.text("SELECT gen_random_uuid()")).scalar_one())
    import uuid

    return str(uuid.uuid4())


def downgrade() -> None:
    """Drop ``transactions.account_id`` and the ``accounts`` table (one-way; see docstring)."""
    op.drop_constraint("fk_transactions_account_id_accounts", "transactions", type_="foreignkey")
    op.drop_index("ix_transactions_account_id", table_name="transactions")
    op.drop_column("transactions", "account_id")
    op.drop_index("ix_accounts_user_id", table_name="accounts")
    op.drop_table("accounts")
