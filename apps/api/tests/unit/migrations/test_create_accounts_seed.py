"""Unit tests for the accounts-seed type helper (ADR-124).

Exercises the pure :func:`account_type_for` helper that backs the in-place backfill
in the ``f7a8b9c0d1e2`` migration: a bank that historically carried card detail
seeds a ``card`` account, otherwise a plain ``bank`` account (ADR-117, ADR-124).
The migration module lives outside the ``src`` import root and has a non-identifier
filename, so it is loaded by path.
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


account_type_for = _load_migration().account_type_for


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
