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

    def test_accounts_seed_and_account_id_backfill(self, integration_database_url: str):
        """
        GIVEN legacy bank-tagged, mixed-currency transactions for two users
        WHEN Alembic upgrades through the accounts migration (ADR-124)
        THEN one account is seeded per distinct (user, bank, currency) group and each
            row is linked to its same-currency account, with the card-detail group
            seeded as type 'card' and the rest as 'bank'

        Proves the corrected per-currency accounts seed + ``account_id`` backfill
        rewrites existing rows on the production PostgreSQL dialect: a bank holding
        both ARS and USD movements yields two accounts (one per currency), so USD
        balances stay USD-authoritative (ADR-123). Partitioned per user (ADR-130).
        """
        # GIVEN — upgrade to the split revision (which has ``card``), then seed rows.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _SPLIT)
        # {label: (user_id, bank, currency, card, expected account type)}.
        seeded: dict[str, tuple[str, str, str, str | None, str]] = {
            # User A: Galicia in ARS (card detail) -> a 'card' ARS account.
            "a_galicia_ars": (_OWNER, "Galicia", "ARS", "VISA ·5771", "card"),
            # User A: Galicia in USD, no card -> a separate 'bank' USD account, same name.
            "a_galicia_usd": (_OWNER, "Galicia", "USD", None, "bank"),
            # User A: Deel USD only, no card -> a single 'bank' USD account.
            "a_deel_usd": (_OWNER, "Deel", "USD", None, "bank"),
            # User A: Mercado Pago ARS, no card -> a 'bank' ARS account.
            "a_mp_ars": (_OWNER, "Mercado Pago", "ARS", None, "bank"),
            # User B: their own Galicia ARS, no card -> independent 'bank' account.
            "b_galicia_ars": (_OWNER_B, "Galicia", "ARS", None, "bank"),
        }
        ids = {label: uuid.uuid4() for label in seeded}
        try:
            asyncio.run(_seed_bank_tagged(integration_database_url, ids, seeded))

            # WHEN
            command.upgrade(config, _ACCOUNTS)

            # THEN — five accounts seeded (one per distinct user+bank+currency group).
            accounts = asyncio.run(_read_accounts(integration_database_url))
            assert len(accounts) == 5
            by_key = {(str(owner), name, currency): acc_type for owner, name, currency, acc_type in accounts}
            # Galicia splits into an ARS 'card' account and a USD 'bank' account, same name.
            assert by_key[(_OWNER, "Galicia", "ARS")] == "card"
            assert by_key[(_OWNER, "Galicia", "USD")] == "bank"
            assert by_key[(_OWNER, "Deel", "USD")] == "bank"
            assert by_key[(_OWNER, "Mercado Pago", "ARS")] == "bank"
            assert by_key[(_OWNER_B, "Galicia", "ARS")] == "bank"

            # THEN — every seeded transaction is linked to its same-(owner,bank,currency) account.
            links = asyncio.run(_read_account_links(integration_database_url, ids))
            for label, (owner, bank, currency, _card, _type) in seeded.items():
                account_id = links[ids[label]]
                assert account_id is not None
                # The linked account belongs to the same owner, bank name, AND currency.
                owner_of, name_of, currency_of = asyncio.run(
                    _account_owner_name_currency(integration_database_url, account_id)
                )
                assert (str(owner_of), name_of, currency_of) == (owner, bank, currency)
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
    seeded: dict[str, tuple[str, str, str, str | None, str]],
) -> None:
    """Insert legacy bank-tagged, mixed-currency transactions for the accounts-seed test."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO transactions (id, user_id, occurred_on, name, kind, amount, currency, payment_method, card) "
        "VALUES (:id, :user_id, :occurred_on, :name, :kind, :amount, :currency, :payment_method, :card)"
    )
    async with engine.begin() as connection:
        for label, (owner, bank, currency, card, _type) in seeded.items():
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


async def _account_owner_name_currency(url: str, account_id: uuid.UUID) -> tuple[uuid.UUID, str, str]:
    """Return the ``(user_id, name, currency)`` of the account with ``account_id``."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT user_id, name, currency FROM accounts WHERE id = :id"),
            {"id": account_id},
        )
        row = result.one()
    await engine.dispose()
    return row.user_id, row.name, row.currency


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
