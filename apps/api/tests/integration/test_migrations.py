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

# The budgets migration (ADR-125): chains after transfers. It creates the
# ``budgets`` table with a NOT NULL owner column and a UNIQUE(user_id, category,
# period) constraint. No data migration is involved.
_BUDGETS = "e2f3a4b5c6d7"

# The budget_income migration (ADR-139): chains after budgets. It creates the
# ``budget_income`` table (per-month net-income base + household floor) with a NOT
# NULL owner column and a UNIQUE(user_id, period) constraint. No data migration.
_BUDGET_INCOME = "f1a2b3c4d5e6"

# The budgets.kind + UNIQUE-swap migration (ADR-138): chains after budget_income. It
# adds ``kind`` (default 'spend') and widens the UNIQUE to
# (user_id, kind, category, period) via batch_alter_table.
_BUDGET_KIND = "a2b3c4d5e6f7"

# The FX-snapshot source + preferred-rate-source migration (ADR-148, ADR-151): chains
# after the budgets.kind swap. It adds the nullable ``transactions.fx_source`` column
# and the NOT NULL ``app_settings.preferred_rate_source`` (server default 'bolsa').
_FX_SNAPSHOT = "b3c4d5e6f7a8"

# The reimbursement offset-link migration (ADR-158, ADR-159): chains after the
# FX-snapshot migration. It adds the nullable self-FK ``transactions.offsets_transaction_id``
# (ON DELETE SET NULL) plus a partial index WHERE kind='reimbursement'. No data migration.
_OFFSET_LINK = "c4d5e6f7a8b9"

# The forecast-schedule fields migration (ADR-174): the head just before the debts table.
# Seeding at it lets the debts-table test start from the pre-debts head.
_FORECAST_FIELDS = "d5e6f7a8b9c0"

# The debts migration (ADR-187): chains after the forecast-schedule fields. It creates the
# ``debts`` table (manual other-debts liability) with a NOT NULL owner column and the two
# NULLABLE extension-point columns. No data migration is involved.
_DEBTS = "e6f7a8b9c0d1"

# The card-identity migration (ADR-190): chains after the debts table. It adds the two
# NULLABLE ``institutions.card_brand`` / ``card_last4`` columns. No data migration.
_CARD_IDENTITY = "f8a9b0c1d2e3"

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

    def test_budgets_migration_creates_table_with_unique_constraint(self, integration_database_url: str):
        """
        GIVEN a database at the transfers revision
        WHEN Alembic upgrades through the budgets migration (ADR-125)
        THEN the budgets table exists, a duplicate (user_id, category, period) is rejected,
             and the downgrade cleanly drops it again

        Proves the schema add AND the UNIQUE(user_id, category, period) constraint on
        the production PostgreSQL dialect: a category gets at most one target per month
        so the upsert never duplicates (ADR-125). No data migration.
        """
        # GIVEN — upgrade to the transfers revision (the head before ADR-125).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _TRANSFERS)
        try:
            # WHEN
            command.upgrade(config, _BUDGETS)

            # THEN — the budgets table exists with the expected columns.
            tables = asyncio.run(_table_names(integration_database_url))
            assert "budgets" in tables
            budget_columns = asyncio.run(_columns(integration_database_url, "budgets"))
            assert {"user_id", "category", "period", "amount", "currency"} <= set(budget_columns)

            # THEN — a duplicate (user_id, category, period) violates the UNIQUE constraint.
            assert asyncio.run(_duplicate_budget_is_rejected(integration_database_url)) is True

            # THEN — the downgrade cleanly drops the table again.
            command.downgrade(config, _TRANSFERS)
            assert "budgets" not in asyncio.run(_table_names(integration_database_url))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_budget_income_migration_creates_table_with_unique_constraint(self, integration_database_url: str):
        """
        GIVEN a database at the budgets revision
        WHEN Alembic upgrades through the budget_income migration (ADR-139)
        THEN the budget_income table exists with the floor columns, a duplicate
             (user_id, period) is rejected, and the downgrade cleanly drops it again

        Proves the schema add AND the UNIQUE(user_id, period) constraint on the
        production PostgreSQL dialect: a user gets at most one income base per month
        so the upsert never duplicates (ADR-139). No data migration.
        """
        # GIVEN — upgrade to the budgets revision (the head before ADR-139).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _BUDGETS)
        try:
            # WHEN
            command.upgrade(config, _BUDGET_INCOME)

            # THEN — the table exists with the income + floor columns.
            tables = asyncio.run(_table_names(integration_database_url))
            assert "budget_income" in tables
            columns = asyncio.run(_columns(integration_database_url, "budget_income"))
            assert {"user_id", "period", "amount", "currency", "source", "floor_amount", "floor_source"} <= set(columns)

            # THEN — a duplicate (user_id, period) violates the UNIQUE constraint.
            assert asyncio.run(_duplicate_income_is_rejected(integration_database_url)) is True

            # THEN — the downgrade cleanly drops the table again.
            command.downgrade(config, _BUDGETS)
            assert "budget_income" not in asyncio.run(_table_names(integration_database_url))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_budget_kind_migration_adds_column_and_swaps_unique(self, integration_database_url: str):
        """
        GIVEN a budgets table holding a spend target (seeded before the kind column)
        WHEN Alembic upgrades through the kind + UNIQUE-swap migration (ADR-138)
        THEN the seeded row back-fills to kind='spend', a spend and a saving row can
             share (category, period), a duplicate spend row is rejected, and the
             downgrade restores the original (user_id, category, period) UNIQUE

        Proves the load-bearing UNIQUE swap to (user_id, kind, category, period) on
        the production PostgreSQL dialect: distinct kinds no longer collide, but a
        duplicate within a kind is still rejected (ADR-138).
        """
        # GIVEN — upgrade to budget_income (the head before ADR-138) and seed a spend row.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _BUDGET_INCOME)
        seeded_id = uuid.uuid4()
        try:
            asyncio.run(_seed_budget_without_kind(integration_database_url, seeded_id))

            # WHEN
            command.upgrade(config, _BUDGET_KIND)

            # THEN — the column exists and the seeded row back-filled to 'spend'.
            columns = asyncio.run(_columns(integration_database_url, "budgets"))
            assert "kind" in columns
            assert asyncio.run(_read_budget_kind(integration_database_url, seeded_id)) == "spend"

            # THEN — a spend and a saving row may now share (category, period).
            assert asyncio.run(_spend_and_saving_coexist(integration_database_url)) is True

            # THEN — a duplicate WITHIN a kind is still rejected by the widened UNIQUE.
            assert asyncio.run(_duplicate_spend_kind_is_rejected(integration_database_url)) is True

            # THEN — the downgrade restores the original UNIQUE and drops kind. A
            # downgrade only runs on a spend-only history, so the saving rows added
            # above (which collide on the narrow key with their spend twin) are
            # cleared first to model that realistic pre-saving state.
            asyncio.run(_delete_saving_rows(integration_database_url))
            command.downgrade(config, _BUDGET_INCOME)
            assert "kind" not in asyncio.run(_columns(integration_database_url, "budgets"))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_fx_snapshot_migration_adds_nullable_source_and_preferred_rate(self, integration_database_url: str):
        """
        GIVEN a database at the budgets.kind revision with a seeded transaction + settings row
        WHEN Alembic upgrades through the FX-snapshot migration (ADR-148, ADR-151)
        THEN transactions gains a NULLABLE fx_source, app_settings gains
             preferred_rate_source back-filled to 'bolsa', and the downgrade drops both

        Proves the additive, non-destructive column adds on the production PostgreSQL
        dialect: ``fx_source`` is nullable (no backfill — usd_amount backfill is
        client-driven, ADR-149), and ``preferred_rate_source`` NOT NULL defaults to
        'bolsa' for existing rows (ADR-151).
        """
        # GIVEN — upgrade to the budgets.kind revision (the head before ADR-148/151) and
        # seed a transaction + a settings row that the column adds must not break.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _BUDGET_KIND)
        transaction_id = uuid.uuid4()
        settings_id = uuid.uuid4()
        try:
            asyncio.run(_seed_one_transaction(integration_database_url, transaction_id))
            asyncio.run(_seed_app_settings(integration_database_url, settings_id))

            # WHEN
            command.upgrade(config, _FX_SNAPSHOT)

            # THEN — the new columns exist.
            tx_columns = asyncio.run(_column_map(integration_database_url, "transactions"))
            settings_columns = asyncio.run(_column_map(integration_database_url, "app_settings"))
            assert "fx_source" in tx_columns
            assert "preferred_rate_source" in settings_columns

            # THEN — fx_source is nullable (no backfill) and the seeded row carries NULL.
            assert tx_columns["fx_source"] is True  # nullable
            assert asyncio.run(_read_fx_source(integration_database_url, transaction_id)) is None

            # THEN — preferred_rate_source is NOT NULL and back-fills existing rows to 'bolsa'.
            assert settings_columns["preferred_rate_source"] is False  # NOT NULL
            assert asyncio.run(_read_preferred_rate_source(integration_database_url, settings_id)) == "bolsa"

            # THEN — the downgrade cleanly drops both columns.
            command.downgrade(config, _BUDGET_KIND)
            assert "fx_source" not in asyncio.run(_columns(integration_database_url, "transactions"))
            assert "preferred_rate_source" not in asyncio.run(_columns(integration_database_url, "app_settings"))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_offset_link_migration_adds_nullable_self_fk_and_partial_index(self, integration_database_url: str):
        """
        GIVEN a database at the FX-snapshot revision with a seeded expense
        WHEN Alembic upgrades through the reimbursement offset-link migration (ADR-158/159)
        THEN transactions gains a NULLABLE offsets_transaction_id self-FK, a
             reimbursement row can link the seeded expense, deleting the expense sets the
             link NULL (ON DELETE SET NULL), the partial index exists, and the downgrade
             drops the column and index

        Proves the additive self-referential FK add on the production PostgreSQL dialect:
        the column is nullable (no backfill — going-forward rollout, ADR-162), the
        ON DELETE SET NULL orphans a payback rather than cascading (ADR-159), and the
        partial index backs the net-spend join (ADR-160).
        """
        # GIVEN — upgrade to the FX-snapshot revision (the head before ADR-158/159) and
        # seed an expense the reimbursement will offset.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _FX_SNAPSHOT)
        expense_id = uuid.uuid4()
        reimbursement_id = uuid.uuid4()
        try:
            asyncio.run(_seed_one_transaction(integration_database_url, expense_id))

            # WHEN
            command.upgrade(config, _OFFSET_LINK)

            # THEN — the nullable self-FK column exists.
            tx_columns = asyncio.run(_column_map(integration_database_url, "transactions"))
            assert "offsets_transaction_id" in tx_columns
            assert tx_columns["offsets_transaction_id"] is True  # nullable

            # THEN — the partial index exists (ADR-160).
            indexes = asyncio.run(_index_names(integration_database_url, "transactions"))
            assert "ix_transactions_offsets_transaction_id" in indexes

            # THEN — a reimbursement can link the expense, and deleting the expense sets
            # the link NULL rather than cascading (ON DELETE SET NULL, ADR-159).
            link = asyncio.run(
                _offset_link_survives_expense_delete(integration_database_url, expense_id, reimbursement_id)
            )
            assert link is None

            # THEN — the downgrade cleanly drops the column and its index.
            command.downgrade(config, _FX_SNAPSHOT)
            assert "offsets_transaction_id" not in asyncio.run(_columns(integration_database_url, "transactions"))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_debts_migration_creates_table_with_owner_index(self, integration_database_url: str):
        """
        GIVEN a database at the forecast-schedule-fields revision (no debts table)
        WHEN Alembic upgrades through the debts migration (ADR-187)
        THEN the debts table exists with the owner + money + nullable extension columns, an
             owned debt row persists, and the downgrade cleanly drops it again

        Proves the schema add on the production PostgreSQL dialect: the ``debts`` table is
        created with a NOT NULL ``user_id`` owner column, a NOT NULL ``current_balance``,
        and the two NULLABLE extension-point columns (ADR-187). No data migration.
        """
        # GIVEN — upgrade to the forecast-fields revision (the head before ADR-187).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _FORECAST_FIELDS)
        try:
            # WHEN
            command.upgrade(config, _DEBTS)

            # THEN — the debts table exists with the expected columns and NULL-ability.
            tables = asyncio.run(_table_names(integration_database_url))
            assert "debts" in tables
            columns = asyncio.run(_column_map(integration_database_url, "debts"))
            assert {"user_id", "name", "currency", "current_balance", "monthly_minimum", "rate"} <= set(columns)
            assert columns["current_balance"] is False  # NOT NULL
            assert columns["monthly_minimum"] is True  # nullable extension point
            assert columns["rate"] is True  # nullable extension point

            # THEN — an owned debt row (with NULL extension points) persists.
            assert asyncio.run(_owned_debt_persists(integration_database_url)) is True

            # THEN — the downgrade cleanly drops the table again.
            command.downgrade(config, _FORECAST_FIELDS)
            assert "debts" not in asyncio.run(_table_names(integration_database_url))
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_card_identity_migration_adds_nullable_brand_and_last4(self, integration_database_url: str):
        """
        GIVEN a database at the debts revision (institutions without card identity)
        WHEN Alembic upgrades through the card-identity migration (ADR-190)
        THEN institutions gains NULLABLE card_brand + card_last4, a card institution
             round-trips its identity, a non-card institution keeps them NULL, and the
             downgrade cleanly drops both columns

        Proves the additive, non-destructive column adds on the production PostgreSQL
        dialect: both columns are nullable (no backfill — bank / cash / wallet
        institutions are unaffected, ADR-190) and a CARD institution persists its
        brand + last4.
        """
        # GIVEN — upgrade to the debts revision (the head before ADR-190).
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, _DEBTS)
        try:
            # WHEN
            command.upgrade(config, _CARD_IDENTITY)

            # THEN — the new columns exist and are nullable.
            columns = asyncio.run(_column_map(integration_database_url, "institutions"))
            assert "card_brand" in columns
            assert "card_last4" in columns
            assert columns["card_brand"] is True  # nullable
            assert columns["card_last4"] is True  # nullable

            # THEN — a CARD institution round-trips its identity, a non-card keeps NULL.
            card, bank = asyncio.run(_card_identity_round_trips(integration_database_url))
            assert card == ("VISA", "5771")
            assert bank == (None, None)

            # THEN — the downgrade cleanly drops both columns.
            command.downgrade(config, _DEBTS)
            institution_columns = asyncio.run(_columns(integration_database_url, "institutions"))
            assert "card_brand" not in institution_columns
            assert "card_last4" not in institution_columns
        finally:
            asyncio.run(_drop_everything(integration_database_url))

    def test_head_matches_orm_metadata_no_drift(self, integration_database_url: str):
        """
        GIVEN a database migrated to head
        WHEN Alembic autogenerate compares the schema against the ORM ``Base.metadata``
        THEN it detects NO differences — the migrations match the models (no drift)

        Proves the debts migration (and every prior migration) faithfully reflects the ORM
        records on real PostgreSQL: an empty autogenerate diff means a fresh
        ``alembic revision --autogenerate`` would produce no upgrade ops (ADR-187 asks for
        ORM <-> migration parity).
        """
        # GIVEN — a database at head.
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", integration_database_url)
        command.upgrade(config, "head")
        try:
            # WHEN / THEN — autogenerate produces no schema differences.
            diffs = asyncio.run(_autogenerate_diffs(integration_database_url))
            assert diffs == [], f"Schema drift between ORM models and migrations: {diffs}"
        finally:
            asyncio.run(_drop_everything(integration_database_url))


async def _card_identity_round_trips(
    url: str,
) -> tuple[tuple[str | None, str | None], tuple[str | None, str | None]]:
    """Insert a CARD and a non-card institution; return each row's ``(card_brand, card_last4)``.

    Proves the card identity persists on a CARD institution while a bank institution
    leaves both columns NULL (ADR-190).
    """
    engine = create_async_engine(url)
    card_id = uuid.uuid4()
    bank_id = uuid.uuid4()
    insert_card = text(
        "INSERT INTO institutions (id, user_id, name, type, card_brand, card_last4) "
        "VALUES (:id, :user_id, :name, :type, :brand, :last4)"
    )
    insert_bank = text("INSERT INTO institutions (id, user_id, name, type) VALUES (:id, :user_id, :name, :type)")
    async with engine.begin() as connection:
        await connection.execute(
            insert_card,
            {
                "id": card_id,
                "user_id": uuid.UUID(_OWNER),
                "name": "Galicia",
                "type": "card",
                "brand": "VISA",
                "last4": "5771",
            },
        )
        await connection.execute(
            insert_bank,
            {"id": bank_id, "user_id": uuid.UUID(_OWNER), "name": "Cash", "type": "cash"},
        )
        result = await connection.execute(
            text("SELECT id, card_brand, card_last4 FROM institutions WHERE id = ANY(:ids)"),
            {"ids": [card_id, bank_id]},
        )
        rows = {row.id: (row.card_brand, row.card_last4) for row in result}
    await engine.dispose()
    return rows[card_id], rows[bank_id]


async def _owned_debt_persists(url: str) -> bool:
    """Insert one owned debt row (NULL extension points) and confirm it round-trips (ADR-187)."""
    engine = create_async_engine(url)
    debt_id = uuid.uuid4()
    insert = text(
        "INSERT INTO debts (id, user_id, name, currency, current_balance) "
        "VALUES (:id, :user_id, :name, :currency, :current_balance)"
    )
    async with engine.begin() as connection:
        await connection.execute(
            insert,
            {
                "id": debt_id,
                "user_id": uuid.UUID(_OWNER),
                "name": "Banco Nación loan",
                "currency": "ARS",
                "current_balance": Decimal("100000.00"),
            },
        )
        result = await connection.execute(
            text("SELECT current_balance, monthly_minimum, rate FROM debts WHERE id = :id"),
            {"id": debt_id},
        )
        row = result.one()
    await engine.dispose()
    return row.current_balance == Decimal("100000.00") and row.monthly_minimum is None and row.rate is None


async def _autogenerate_diffs(url: str) -> list:
    """Return the Alembic autogenerate diff between the live schema and ``Base.metadata``.

    An empty list means the migrations are in sync with the ORM records — a fresh
    ``alembic revision --autogenerate`` would emit no ops (no drift). Runs the comparison
    on a synchronous connection because Alembic's ``compare_metadata`` is sync.

    Some test modules register throwaway ORM records on the SHARED production
    ``Base.metadata`` (e.g. ``uow_test_widgets`` in the unit-of-work unit test), which are
    NOT part of any migration. When the whole suite is imported those tables pollute the
    metadata side of the comparison as spurious "add table" ops. An ``include_object``
    hook drops any metadata table not managed by the migrations (absent from the live DB),
    so a stray test-only ORM table is ignored — this checks real drift only.
    """
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import inspect

    from margen_api.adapters import models  # noqa: F401  (registers tables on Base.metadata)
    from margen_api.adapters.models.base import Base

    engine = create_async_engine(url)

    def _compare(sync_conn) -> list:  # type: ignore[no-untyped-def]
        migrated_tables = set(inspect(sync_conn).get_table_names())

        def include_object(obj, name, type_, reflected, _compare_to) -> bool:  # type: ignore[no-untyped-def]
            # Applied to BOTH reflected (DB) and metadata (ORM) objects. Drop any table the
            # migrations do not manage (absent from the live DB) so a test-only ORM table
            # registered on the shared Base.metadata is not reported as spurious drift.
            if type_ == "table" and not reflected:
                return name in migrated_tables
            return True

        context = MigrationContext.configure(sync_conn, opts={"include_object": include_object})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_compare)
    await engine.dispose()
    return diffs


async def _index_names(url: str, table: str) -> list[str | None]:
    """Return the index names on ``table``."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        names = await connection.run_sync(
            lambda sync_conn: [ix["name"] for ix in inspect(sync_conn).get_indexes(table)]
        )
    await engine.dispose()
    return names


async def _offset_link_survives_expense_delete(
    url: str,
    expense_id: uuid.UUID,
    reimbursement_id: uuid.UUID,
) -> uuid.UUID | None:
    """Link a reimbursement to the expense, delete the expense, and return the link value.

    Proves ON DELETE SET NULL (ADR-159): after deleting the source expense the payback
    row survives with a NULL ``offsets_transaction_id`` rather than being cascaded away.
    """
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO transactions (id, user_id, occurred_on, name, kind, amount, currency, offsets_transaction_id) "
        "VALUES (:id, :user_id, :occurred_on, :name, :kind, :amount, :currency, :offsets)"
    )
    async with engine.begin() as connection:
        await connection.execute(
            insert,
            {
                "id": reimbursement_id,
                "user_id": uuid.UUID(_OWNER),
                "occurred_on": datetime.date(2026, 6, 20),
                "name": "Friend pays back",
                "kind": "reimbursement",
                "amount": Decimal("3000.00"),
                "currency": "ARS",
                "offsets": expense_id,
            },
        )
        await connection.execute(text("DELETE FROM transactions WHERE id = :id"), {"id": expense_id})
        result = await connection.execute(
            text("SELECT offsets_transaction_id FROM transactions WHERE id = :id"),
            {"id": reimbursement_id},
        )
        value = result.scalar_one()
    await engine.dispose()
    return value


async def _duplicate_income_is_rejected(url: str) -> bool:
    """Insert two income rows with the same (user_id, period); return whether the 2nd fails."""
    from sqlalchemy.exc import IntegrityError

    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO budget_income (id, user_id, period, amount, currency, source, floor_source) "
        "VALUES (:id, :user_id, :period, :amount, :currency, :source, :floor_source)"
    )
    base = {
        "user_id": uuid.UUID(_OWNER),
        "period": datetime.date(2026, 6, 1),
        "amount": Decimal("1000000.00"),
        "currency": "ARS",
        "source": "manual",
        "floor_source": "manual",
    }
    rejected = False
    async with engine.begin() as connection:
        await connection.execute(insert, {"id": uuid.uuid4(), **base})
    try:
        async with engine.begin() as connection:
            await connection.execute(insert, {"id": uuid.uuid4(), **base})
    except IntegrityError:
        rejected = True
    await engine.dispose()
    return rejected


async def _seed_budget_without_kind(url: str, budget_id: uuid.UUID) -> None:
    """Insert a budget row before the kind column exists (back-fill target)."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO budgets (id, user_id, category, period, amount, currency) "
        "VALUES (:id, :user_id, :category, :period, :amount, :currency)"
    )
    async with engine.begin() as connection:
        await connection.execute(
            insert,
            {
                "id": budget_id,
                "user_id": uuid.UUID(_OWNER),
                "category": "Food",
                "period": datetime.date(2026, 6, 1),
                "amount": Decimal("50000.00"),
                "currency": "ARS",
            },
        )
    await engine.dispose()


async def _read_budget_kind(url: str, budget_id: uuid.UUID) -> str:
    """Return the ``kind`` of the seeded budget row after the back-fill."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT kind FROM budgets WHERE id = :id"), {"id": budget_id})
        value = result.scalar_one()
    await engine.dispose()
    return str(value)


async def _spend_and_saving_coexist(url: str) -> bool:
    """Insert a spend and a saving row sharing (category, period); return whether both persist."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO budgets (id, user_id, category, period, amount, currency, kind) "
        "VALUES (:id, :user_id, :category, :period, :amount, :currency, :kind)"
    )
    base = {
        "user_id": uuid.UUID(_OWNER_B),
        "category": "EmergencyFund",
        "period": datetime.date(2026, 7, 1),
        "amount": Decimal("10000.00"),
        "currency": "ARS",
    }
    async with engine.begin() as connection:
        await connection.execute(insert, {"id": uuid.uuid4(), "kind": "spend", **base})
        await connection.execute(insert, {"id": uuid.uuid4(), "kind": "saving", **base})
        result = await connection.execute(
            text("SELECT count(*) FROM budgets WHERE user_id = :u AND category = :c AND period = :p"),
            {"u": base["user_id"], "c": base["category"], "p": base["period"]},
        )
        count = result.scalar_one()
    await engine.dispose()
    return count == 2


async def _delete_saving_rows(url: str) -> None:
    """Delete every ``kind='saving'`` row so the narrow-UNIQUE downgrade is safe."""
    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.execute(text("DELETE FROM budgets WHERE kind = 'saving'"))
    await engine.dispose()


async def _duplicate_spend_kind_is_rejected(url: str) -> bool:
    """Insert two spend rows on the same (user_id, kind, category, period); 2nd must fail."""
    from sqlalchemy.exc import IntegrityError

    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO budgets (id, user_id, category, period, amount, currency, kind) "
        "VALUES (:id, :user_id, :category, :period, :amount, :currency, 'spend')"
    )
    base = {
        "user_id": uuid.UUID(_OWNER),
        "category": "Transport",
        "period": datetime.date(2026, 8, 1),
        "amount": Decimal("8000.00"),
        "currency": "ARS",
    }
    rejected = False
    async with engine.begin() as connection:
        await connection.execute(insert, {"id": uuid.uuid4(), **base})
    try:
        async with engine.begin() as connection:
            await connection.execute(insert, {"id": uuid.uuid4(), **base})
    except IntegrityError:
        rejected = True
    await engine.dispose()
    return rejected


async def _duplicate_budget_is_rejected(url: str) -> bool:
    """Insert two budgets with the same (user_id, category, period); return whether the 2nd fails.

    Proves the UNIQUE(user_id, category, period) constraint backs the upsert: a
    category gets one target per month (ADR-125). The first insert succeeds; the
    second, identical on the natural key, must raise an IntegrityError.
    """
    from sqlalchemy.exc import IntegrityError

    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO budgets (id, user_id, category, period, amount, currency) "
        "VALUES (:id, :user_id, :category, :period, :amount, :currency)"
    )
    base = {
        "user_id": uuid.UUID(_OWNER),
        "category": "Food",
        "period": datetime.date(2026, 6, 1),
        "amount": Decimal("50000.00"),
        "currency": "ARS",
    }
    rejected = False
    async with engine.begin() as connection:
        await connection.execute(insert, {"id": uuid.uuid4(), **base})
    try:
        async with engine.begin() as connection:
            await connection.execute(insert, {"id": uuid.uuid4(), **base})
    except IntegrityError:
        rejected = True
    await engine.dispose()
    return rejected


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


async def _column_map(url: str, table: str) -> dict[str, bool]:
    """Return ``{column_name: nullable}`` for ``table`` so a test can assert NULL-ability."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        columns = await connection.run_sync(lambda sync_conn: inspect(sync_conn).get_columns(table))
    await engine.dispose()
    return {col["name"]: bool(col["nullable"]) for col in columns}


async def _seed_one_transaction(url: str, transaction_id: uuid.UUID) -> None:
    """Insert one transaction before the fx_source column exists (the no-backfill target)."""
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO transactions (id, user_id, occurred_on, name, kind, amount, currency) "
        "VALUES (:id, :user_id, :occurred_on, :name, :kind, :amount, :currency)"
    )
    async with engine.begin() as connection:
        await connection.execute(
            insert,
            {
                "id": transaction_id,
                "user_id": uuid.UUID(_OWNER),
                "occurred_on": datetime.date(2026, 6, 1),
                "name": "Legacy USD spend",
                "kind": "expense",
                "amount": Decimal("50000.00"),
                "currency": "USD",
            },
        )
    await engine.dispose()


async def _read_fx_source(url: str, transaction_id: uuid.UUID) -> str | None:
    """Return the ``fx_source`` of the seeded transaction after the column add."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT fx_source FROM transactions WHERE id = :id"),
            {"id": transaction_id},
        )
        value = result.scalar_one()
    await engine.dispose()
    return value


async def _read_preferred_rate_source(url: str, settings_id: uuid.UUID) -> str:
    """Return the ``preferred_rate_source`` of the seeded app_settings row after the back-fill."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT preferred_rate_source FROM app_settings WHERE id = :id"),
            {"id": settings_id},
        )
        value = result.scalar_one()
    await engine.dispose()
    return str(value)


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
