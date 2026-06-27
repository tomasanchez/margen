"""split payment attribution into normalized bank + card

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-06-27 00:00:00.000000

Splits a transaction's payment attribution into a normalized, filterable bank
(the existing ``payment_method`` column, exposed as JSON ``bank``) plus a new
optional, display-only ``card`` detail column (JSON ``card``) (ADR-117).

The upgrade adds the nullable ``card`` column, then **backfills existing rows
in place** by deterministically splitting the current ``payment_method`` label:

* starts with ``"Galicia"`` -> bank ``"Galicia"``; card is the remainder with
  leading separators / spaces / ``·`` trimmed (``"Galicia VISA ·5771"`` ->
  ``"VISA ·5771"``; ``"Galicia · Visa"`` -> ``"Visa"``). An empty remainder ->
  card ``NULL``.
* starts with ``"Santander"`` -> bank ``"Santander"``; card is the trimmed
  remainder (``"Santander AMEX"`` -> ``"AMEX"``; ``"Santander AMEX ·1234"`` ->
  ``"AMEX ·1234"``; ``"Santander · Mastercard"`` -> ``"Mastercard"``). Empty ->
  ``NULL``.
* exactly ``"Mercado Pago"`` / ``"Brubank"`` / ``"Deel"`` / ``"Transfer"`` ->
  bank unchanged, card ``NULL``.
* anything else (incl. ``NULL`` / unknown legacy strings) -> left as-is
  (bank = that string), card ``NULL``.

The backfill is applied row by row through the bind connection with a parameter-
bound ``UPDATE`` so it is portable across PostgreSQL / Supabase (the production
target) and the in-memory SQLite the e2e tier uses. Adding the column is
SQLite-compatible (plain ``ADD COLUMN``).

This migration **rewrites existing rows**, so it MUST be applied to Supabase via
``cd apps/api && uv run --env-file .env alembic upgrade head`` to normalize the
stored labels.

The ``downgrade`` drops the ``card`` column. The bank normalization performed on
``payment_method`` is intentionally ONE-WAY: a downgrade does NOT reconstruct the
old composed labels (the original card detail is preserved on its own column and
simply discarded when that column is dropped).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | Sequence[str] | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The middot the parsers print between the network and the last-4 (ADR-079/117).
_MIDDOT = "·"

# Banks whose composed label carries a card detail to split off (ADR-117).
_SPLIT_BANKS: tuple[str, ...] = ("Galicia", "Santander")

# Banks that are already normalized single-word labels with no card (ADR-117).
_NO_CARD_BANKS: frozenset[str] = frozenset({"Mercado Pago", "Brubank", "Deel", "Transfer"})


def split_bank_and_card(payment_method: str | None) -> tuple[str | None, str | None]:
    """Split a legacy ``payment_method`` label into ``(bank, card)`` (ADR-117).

    Pure, deterministic helper backing the in-place backfill so the rules are
    unit-testable in isolation (no DB needed).

    Args:
        payment_method: The current stored label, or ``None``.

    Returns:
        A ``(bank, card)`` tuple. ``bank`` is the normalized bank (or the original
        string when it is not a known composed label, or ``None`` when the input is
        ``None``); ``card`` is the trimmed card / detail remainder, or ``None`` when
        there is no card.
    """
    if payment_method is None:
        return None, None

    for bank in _SPLIT_BANKS:
        if payment_method.startswith(bank):
            remainder = payment_method[len(bank) :]
            # Trim leading separators / spaces / middots so "Galicia · Visa" yields
            # "Visa" and "Galicia VISA ·5771" yields "VISA ·5771".
            card = remainder.strip().lstrip(_MIDDOT).strip()
            return bank, (card or None)

    if payment_method in _NO_CARD_BANKS:
        return payment_method, None

    # Unknown / legacy string: keep it as the bank, no card (tolerated, ADR-117).
    return payment_method, None


def upgrade() -> None:
    """Add the nullable ``card`` column and backfill the bank/card split in place."""
    op.add_column("transactions", sa.Column("card", sa.String(length=100), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, payment_method FROM transactions WHERE payment_method IS NOT NULL")
    ).fetchall()
    update = sa.text("UPDATE transactions SET payment_method = :bank, card = :card WHERE id = :id")
    for row in rows:
        bank, card = split_bank_and_card(row.payment_method)
        # Only write rows whose label actually changes (a card was split off or the
        # bank was normalized); a no-op label leaves the row untouched.
        if bank != row.payment_method or card is not None:
            bind.execute(update, {"id": row.id, "bank": bank, "card": card})


def downgrade() -> None:
    """Drop the ``card`` column (the bank normalization is one-way; see the docstring)."""
    op.drop_column("transactions", "card")
