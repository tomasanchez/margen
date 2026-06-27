"""Integration tests for Alembic migrations against PostgreSQL."""

import asyncio
import datetime
import uuid
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

pytestmark = pytest.mark.integration

# The revision just before the bank/card split, and the split revision itself
# (ADR-117). Seeding at ``_PRE_SPLIT`` lets the test exercise the in-place backfill.
_PRE_SPLIT = "d4e5f6a7b8c9"
_SPLIT = "e5f6a7b8c9d0"

# A user_id for the seeded legacy rows (the column is NOT NULL by ``_PRE_SPLIT``).
_OWNER = "00000000-0000-4000-8000-000000000001"


async def _table_names(url: str) -> list[str]:
    """Return the table names visible on the database at ``url``."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        names = await connection.run_sync(lambda sync_conn: inspect(sync_conn).get_table_names())
    await engine.dispose()
    return names


async def _drop_everything(url: str) -> None:
    """Drop all tables so the migration test leaves a clean database."""
    from sqlalchemy import text

    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.execute(text("DROP SCHEMA public CASCADE"))
        await connection.execute(text("CREATE SCHEMA public"))
    await engine.dispose()


class TestMigrations:
    """Test cases for relational schema migrations."""

    def test_upgrades_a_blank_database_to_head(self, integration_database_url: str):
        """
        GIVEN a blank PostgreSQL database
        WHEN Alembic upgrades the database to head
        THEN Alembic records its revision table even with no migrations yet

        This test is synchronous so that Alembic's async ``env.py`` can manage
        its own event loop via ``asyncio.run`` without colliding with a running
        loop (mirroring how ``alembic upgrade head`` runs on the command line).
        """
        # GIVEN
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)

        # WHEN
        command.upgrade(config, "head")

        # THEN
        try:
            tables = asyncio.run(_table_names(integration_database_url))
            assert "alembic_version" in tables
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_backfill_splits_bank_and_card_in_place(self, integration_database_url: str):
        """
        GIVEN legacy transactions whose payment_method composes bank + card
        WHEN Alembic upgrades through the ADR-117 split migration
        THEN each row's payment_method is the normalized bank and card the detail

        Proves the in-place data backfill rewrites existing rows on the production
        PostgreSQL dialect, not just the schema add (ADR-117).
        """
        # GIVEN — upgrade to the revision just before the split, then seed legacy rows.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _PRE_SPLIT)
        # {label: (original payment_method, expected bank, expected card)} (ADR-117).
        seeded: dict[str, tuple[str, str, str | None]] = {
            "galicia": ("Galicia VISA ·5771", "Galicia", "VISA ·5771"),
            "santander": ("Santander AMEX ·1234", "Santander", "AMEX ·1234"),
            "mp": ("Mercado Pago", "Mercado Pago", None),
            "legacy": ("Some Old Wallet", "Some Old Wallet", None),
        }
        ids = {label: uuid.uuid4() for label in seeded}
        try:
            asyncio.run(_seed_transactions(integration_database_url, ids, seeded))

            # WHEN
            command.upgrade(config, _SPLIT)

            # THEN
            rows = asyncio.run(_read_bank_and_card(integration_database_url, ids))
            for label, (_original, expected_bank, expected_card) in seeded.items():
                assert rows[ids[label]] == (expected_bank, expected_card)
        finally:
            asyncio.run(_drop_everything(integration_database_url))


async def _seed_transactions(
    url: str,
    ids: dict[str, uuid.UUID],
    seeded: dict[str, tuple[str, str, str | None]],
) -> None:
    """Insert legacy transactions carrying composed ``payment_method`` labels."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO transactions (id, user_id, occurred_on, name, kind, amount, currency, payment_method) "
        "VALUES (:id, :user_id, :occurred_on, :name, :kind, :amount, :currency, :payment_method)"
    )
    async with engine.begin() as connection:
        for label, (original, _bank, _card) in seeded.items():
            await connection.execute(
                insert,
                {
                    "id": ids[label],
                    "user_id": uuid.UUID(_OWNER),
                    "occurred_on": datetime.date(2026, 6, 1),
                    "name": f"row-{label}",
                    "kind": "expense",
                    "amount": Decimal("1000.00"),
                    "currency": "ARS",
                    "payment_method": original,
                },
            )
    await engine.dispose()


async def _read_bank_and_card(
    url: str,
    ids: dict[str, uuid.UUID],
) -> dict[uuid.UUID, tuple[str | None, str | None]]:
    """Return ``{id: (payment_method, card)}`` for the seeded rows after the backfill."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT id, payment_method, card FROM transactions WHERE id = ANY(:ids)"),
            {"ids": list(ids.values())},
        )
        rows = {row.id: (row.payment_method, row.card) for row in result}
    await engine.dispose()
    return rows
