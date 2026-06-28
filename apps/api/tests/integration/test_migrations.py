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

# The accounts migration (ADR-122/124): chains after the split. Seeding at ``_SPLIT``
# (which already has the ``card`` column) lets the test exercise the accounts seed +
# account_id backfill on real PostgreSQL.
_ACCOUNTS = "f7a8b9c0d1e2"

# The monotributo_enabled migration (ADR-126): chains after the accounts migration.
# Seeding an app_settings row at ``_ACCOUNTS`` lets the test exercise the boolean
# add + back-fill of existing rows to TRUE on real PostgreSQL.
_MONOTRIBUTO_FLAG = "a8b9c0d1e2f3"

# The Institution -> Account hierarchy migration (ADR-134): chains after the
# monotributo_enabled flag. It creates ``institutions``, adds the NOT NULL
# ``accounts.institution_id`` FK and drops ``accounts.name`` / ``accounts.type``.
_INSTITUTION_HIERARCHY = "c0d1e2f3a4b5"

# The transfers migration (ADR-135): chains after the Institution -> Account
# hierarchy. It creates the ``transfers`` table with two account FKs and an owner
# column. No data migration is involved.
_TRANSFERS = "d1e2f3a4b5c6"

# A user_id for the seeded legacy rows (the column is NOT NULL by ``_PRE_SPLIT``).
_OWNER = "00000000-0000-4000-8000-000000000001"
# A second owner, to prove the seed is partitioned per user_id (ADR-124, ADR-130).
_OWNER_B = "00000000-0000-4000-8000-000000000002"


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

    def test_accounts_migration_seeds_nothing(self, integration_database_url: str):
        """
        GIVEN legacy bank-tagged, mixed-currency transactions for two users
        WHEN Alembic upgrades through the accounts migration (ADR-124, amended)
        THEN the accounts table is empty and every transaction's account_id is NULL

        Proves the accounts migration adds schema only — no data migration — on the
        production PostgreSQL dialect: the ``accounts`` table starts empty (the owner
        creates accounts manually) and existing transactions stay unlinked
        (``account_id`` NULL) until the owner assigns them (ADR-124, amended; ADR-130).
        """
        # GIVEN — upgrade to the split revision (which has ``card``), then seed rows.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _SPLIT)
        # {label: (user_id, bank, currency, card)} — bank-tagged rows that, under the
        # original decision, would have seeded accounts; now they must seed nothing.
        seeded: dict[str, tuple[str, str, str, str | None]] = {
            "a_galicia_ars": (_OWNER, "Galicia", "ARS", "VISA ·5771"),
            "a_galicia_usd": (_OWNER, "Galicia", "USD", None),
            "a_deel_usd": (_OWNER, "Deel", "USD", None),
            "a_mp_ars": (_OWNER, "Mercado Pago", "ARS", None),
            "b_galicia_ars": (_OWNER_B, "Galicia", "ARS", None),
        }
        ids = {label: uuid.uuid4() for label in seeded}
        try:
            asyncio.run(_seed_bank_tagged(integration_database_url, ids, seeded))

            # WHEN
            command.upgrade(config, _ACCOUNTS)

            # THEN — the migration seeds no accounts.
            accounts = asyncio.run(_read_accounts(integration_database_url))
            assert accounts == []

            # THEN — every existing transaction stays unlinked (account_id NULL).
            links = asyncio.run(_read_account_links(integration_database_url, ids))
            assert all(account_id is None for account_id in links.values())
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_monotributo_enabled_backfills_existing_rows_to_true(self, integration_database_url: str):
        """
        GIVEN an existing app_settings row at the pre-flag revision
        WHEN Alembic upgrades through the monotributo_enabled migration (ADR-126)
        THEN the column exists and the existing row is back-filled to monotributo_enabled=true

        Proves the in-place back-fill preserves Monotributo access for current users on
        the production PostgreSQL dialect, while new rows default to FALSE (ADR-126).
        """
        # GIVEN — upgrade to the accounts revision (just before the flag), then seed a row.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _ACCOUNTS)
        settings_id = uuid.uuid4()
        try:
            asyncio.run(_seed_app_settings(integration_database_url, settings_id))

            # WHEN
            command.upgrade(config, _MONOTRIBUTO_FLAG)

            # THEN — the column exists and the pre-existing row was flipped to TRUE.
            columns = asyncio.run(_app_settings_columns(integration_database_url))
            assert "monotributo_enabled" in columns
            enabled = asyncio.run(_read_monotributo_enabled(integration_database_url, settings_id))
            assert enabled is True
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_institution_hierarchy_restructures_accounts(self, integration_database_url: str):
        """
        GIVEN a database at the monotributo-flag revision (flat accounts, empty table)
        WHEN Alembic upgrades through the Institution -> Account hierarchy migration (ADR-134)
        THEN the institutions table exists, accounts gains institution_id, and name/type are gone

        Proves the schema restructure on the production PostgreSQL dialect: a new
        ``institutions`` table is created, ``accounts.institution_id`` is added (the
        table is empty so the NOT NULL FK is safe) and the ``name`` / ``type``
        columns move off the account (ADR-134). No data migration is involved.
        """
        # GIVEN — upgrade to the flag revision (the flat-account head before ADR-134).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _MONOTRIBUTO_FLAG)
        try:
            # WHEN
            command.upgrade(config, _INSTITUTION_HIERARCHY)

            # THEN — the institutions table now exists.
            tables = asyncio.run(_table_names(integration_database_url))
            assert "institutions" in tables

            # THEN — accounts gained institution_id and lost name/type (ADR-134).
            account_columns = asyncio.run(_columns(integration_database_url, "accounts"))
            assert "institution_id" in account_columns
            assert "name" not in account_columns
            assert "type" not in account_columns
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_transfers_migration_creates_table(self, integration_database_url: str):
        """
        GIVEN a database at the Institution -> Account hierarchy revision
        WHEN Alembic upgrades through the transfers migration (ADR-135)
        THEN the transfers table exists with both account FK columns and the owner column

        Proves the schema add on the production PostgreSQL dialect: the ``transfers``
        table is created with ``from_account_id`` / ``to_account_id`` FKs to accounts
        and a NOT NULL ``user_id`` owner column (ADR-135). No data migration.
        """
        # GIVEN — upgrade to the hierarchy revision (the head before ADR-135).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _INSTITUTION_HIERARCHY)
        try:
            # WHEN
            command.upgrade(config, _TRANSFERS)

            # THEN — the transfers table exists with the expected columns.
            tables = asyncio.run(_table_names(integration_database_url))
            assert "transfers" in tables
            transfer_columns = asyncio.run(_columns(integration_database_url, "transfers"))
            assert {"from_account_id", "to_account_id", "amount_out", "amount_in", "user_id"} <= set(transfer_columns)

            # THEN — the downgrade cleanly drops the table again.
            command.downgrade(config, _INSTITUTION_HIERARCHY)
            assert "transfers" not in asyncio.run(_table_names(integration_database_url))
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


async def _seed_bank_tagged(
    url: str,
    ids: dict[str, uuid.UUID],
    seeded: dict[str, tuple[str, str, str, str | None]],
) -> None:
    """Insert legacy bank-tagged, mixed-currency transactions for the accounts-migration test."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO transactions (id, user_id, occurred_on, name, kind, amount, currency, payment_method, card) "
        "VALUES (:id, :user_id, :occurred_on, :name, :kind, :amount, :currency, :payment_method, :card)"
    )
    async with engine.begin() as connection:
        for label, (owner, bank, currency, card) in seeded.items():
            await connection.execute(
                insert,
                {
                    "id": ids[label],
                    "user_id": uuid.UUID(owner),
                    "occurred_on": datetime.date(2026, 6, 1),
                    "name": f"row-{label}",
                    "kind": "expense",
                    "amount": Decimal("1000.00"),
                    "currency": currency,
                    "payment_method": bank,
                    "card": card,
                },
            )
    await engine.dispose()


async def _read_accounts(url: str) -> list[tuple[uuid.UUID, str, str, str]]:
    """Return the seeded accounts as ``(user_id, name, currency, type)`` tuples."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT user_id, name, currency, type FROM accounts"))
        rows = [(row.user_id, row.name, row.currency, row.type) for row in result]
    await engine.dispose()
    return rows


async def _read_account_links(
    url: str,
    ids: dict[str, uuid.UUID],
) -> dict[uuid.UUID, uuid.UUID | None]:
    """Return ``{transaction_id: account_id}`` for the seeded rows after the backfill."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT id, account_id FROM transactions WHERE id = ANY(:ids)"),
            {"ids": list(ids.values())},
        )
        rows = {row.id: row.account_id for row in result}
    await engine.dispose()
    return rows


async def _seed_app_settings(url: str, settings_id: uuid.UUID) -> None:
    """Insert one existing app_settings row before the monotributo_enabled flag (ADR-126)."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO app_settings "
        "(id, user_id, preferred_display_currency, fx_default_rate_type, "
        "monotributo_current_category, monotributo_activity_type) "
        "VALUES (:id, :user_id, :currency, :fx, :category, :activity)"
    )
    async with engine.begin() as connection:
        await connection.execute(
            insert,
            {
                "id": settings_id,
                "user_id": uuid.UUID(_OWNER),
                "currency": "ARS",
                "fx": "MEP",
                "category": "C",
                "activity": "services",
            },
        )
    await engine.dispose()


async def _columns(url: str, table: str) -> list[str]:
    """Return the column names on ``table``."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        names = await connection.run_sync(
            lambda sync_conn: [col["name"] for col in inspect(sync_conn).get_columns(table)]
        )
    await engine.dispose()
    return names


async def _app_settings_columns(url: str) -> list[str]:
    """Return the column names on the ``app_settings`` table."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        names = await connection.run_sync(
            lambda sync_conn: [col["name"] for col in inspect(sync_conn).get_columns("app_settings")]
        )
    await engine.dispose()
    return names


async def _read_monotributo_enabled(url: str, settings_id: uuid.UUID) -> bool:
    """Return the ``monotributo_enabled`` value of the app_settings row after the back-fill."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT monotributo_enabled FROM app_settings WHERE id = :id"),
            {"id": settings_id},
        )
        value = result.scalar_one()
    await engine.dispose()
    return bool(value)
