"""Unit tests for the pure accounts-seed planning helpers (ADR-124).

Exercises the pure helpers that back the in-place backfill in the ``f7a8b9c0d1e2``
migration: :func:`account_type_for` (a group that carried card detail seeds a
``card`` account, otherwise ``bank`` — ADR-117) and :func:`plan_seed_accounts` (the
corrected rule: one account per distinct ``(user, bank, currency)`` group, with the
account's currency set from the group — ADR-123, ADR-124). The migration module
lives outside the ``src`` import root and has a non-identifier filename, so it is
loaded by path.
"""

import importlib.util
from pathlib import Path
from types import ModuleType

_MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "migrations"
    / "versions"
    / "f7a8b9c0d1e2_create_accounts_seed_from_bank_tags.py"
)


def _load_migration() -> ModuleType:
    """Load the accounts-seed migration module by file path (it is outside ``src``)."""
    spec = importlib.util.spec_from_file_location("_create_accounts_seed_migration", _MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_migration = _load_migration()
account_type_for = _migration.account_type_for
plan_seed_accounts = _migration.plan_seed_accounts
SeedGroup = _migration.SeedGroup


class TestAccountTypeFor:
    """The deterministic bank-vs-card seeding rule (ADR-124)."""

    async def test_card_detail_seeds_a_card_account(self):
        """
        GIVEN a bank whose transactions carried card detail
        WHEN the seeded account type is decided
        THEN it is a 'card' account (ADR-117, ADR-124)
        """
        # WHEN / THEN
        assert account_type_for(has_card_detail=True) == "card"

    async def test_no_card_detail_seeds_a_bank_account(self):
        """
        GIVEN a bank whose transactions never carried card detail
        WHEN the seeded account type is decided
        THEN it defaults to a 'bank' account (ADR-124)
        """
        # WHEN / THEN
        assert account_type_for(has_card_detail=False) == "bank"


class TestPlanSeedAccounts:
    """The corrected per-(user, bank, currency) seeding rule (ADR-123, ADR-124)."""

    async def test_one_account_per_group_carries_groups_currency(self):
        """
        GIVEN distinct (user, bank, currency) groups
        WHEN the seed is planned
        THEN one account is planned per group, each with the group's currency (ADR-123)
        """
        # GIVEN — one owner; Galicia in both ARS and USD, plus a USD-only Deel.
        groups = [
            SeedGroup(user_id="u1", payment_method="Galicia", currency="ARS", has_card_detail=False),
            SeedGroup(user_id="u1", payment_method="Galicia", currency="USD", has_card_detail=False),
            SeedGroup(user_id="u1", payment_method="Deel", currency="USD", has_card_detail=False),
        ]

        # WHEN
        planned = plan_seed_accounts(groups)

        # THEN — three accounts; Galicia appears twice, once per currency, same name.
        assert len(planned) == 3
        by_key = {(p.payment_method, p.currency): p for p in planned}
        assert by_key[("Galicia", "ARS")].currency == "ARS"
        assert by_key[("Galicia", "USD")].currency == "USD"
        # The shared name is NOT disambiguated — currency does that (ADR-124).
        assert by_key[("Galicia", "ARS")].name == "Galicia"
        assert by_key[("Galicia", "USD")].name == "Galicia"
        assert by_key[("Deel", "USD")].currency == "USD"

    async def test_card_detail_in_group_makes_a_card_account(self):
        """
        GIVEN a group whose transactions carried card detail
        WHEN the seed is planned
        THEN that account's type is 'card' (ADR-117, ADR-124)
        """
        # GIVEN
        groups = [SeedGroup(user_id="u1", payment_method="Galicia", currency="ARS", has_card_detail=True)]

        # WHEN
        planned = plan_seed_accounts(groups)

        # THEN
        assert planned[0].type == "card"

    async def test_groups_are_partitioned_per_user(self):
        """
        GIVEN two users sharing a bank name and currency
        WHEN the seed is planned
        THEN each user gets an independent account (ADR-130)
        """
        # GIVEN
        groups = [
            SeedGroup(user_id="u1", payment_method="Galicia", currency="ARS", has_card_detail=False),
            SeedGroup(user_id="u2", payment_method="Galicia", currency="ARS", has_card_detail=False),
        ]

        # WHEN
        planned = plan_seed_accounts(groups)

        # THEN
        assert {p.user_id for p in planned} == {"u1", "u2"}
        assert len(planned) == 2

    async def test_empty_groups_plan_no_accounts(self):
        """
        GIVEN no transaction groups
        WHEN the seed is planned
        THEN no accounts are planned
        """
        # WHEN / THEN
        assert plan_seed_accounts([]) == []
