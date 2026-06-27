"""Unit tests for the bank/card split backfill helper (ADR-117).

Exercises the pure :func:`split_bank_and_card` helper that backs the in-place
backfill in the ``e5f6a7b8c9d0`` migration, covering each deterministic rule
including the unknown / NULL passthrough. The migration module lives outside the
``src`` import root and has a non-identifier filename, so it is loaded by path.
"""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

_MIGRATION_PATH = (
    Path(__file__).resolve().parents[3] / "migrations" / "versions" / "e5f6a7b8c9d0_split_bank_and_card.py"
)


def _load_migration() -> ModuleType:
    """Load the split migration module by file path (it is outside ``src``)."""
    spec = importlib.util.spec_from_file_location("_split_bank_and_card_migration", _MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


split_bank_and_card = _load_migration().split_bank_and_card


class TestSplitBankAndCard:
    """The deterministic bank/card split applied to the legacy label (ADR-117)."""

    @pytest.mark.parametrize(
        ("label", "expected"),
        [
            # Galicia: composed network + last4 -> bank "Galicia", card the remainder.
            ("Galicia VISA ·5771", ("Galicia", "VISA ·5771")),
            # Galicia: prototype "Galicia · Visa" -> middot + spaces trimmed to "Visa".
            ("Galicia · Visa", ("Galicia", "Visa")),
            # Galicia with no detail -> empty remainder collapses to no card.
            ("Galicia", ("Galicia", None)),
            # Santander AMEX with no last4 -> card "AMEX".
            ("Santander AMEX", ("Santander", "AMEX")),
            # Santander AMEX with last4 -> card "AMEX ·1234".
            ("Santander AMEX ·1234", ("Santander", "AMEX ·1234")),
            # Santander VISA with no last4 -> card "VISA".
            ("Santander VISA", ("Santander", "VISA")),
            # Santander prototype "Santander · Mastercard" -> card "Mastercard".
            ("Santander · Mastercard", ("Santander", "Mastercard")),
            # Normalized no-card banks pass through unchanged with a NULL card.
            ("Mercado Pago", ("Mercado Pago", None)),
            ("Brubank", ("Brubank", None)),
            ("Deel", ("Deel", None)),
            ("Transfer", ("Transfer", None)),
            # Unknown legacy string is kept as-is (bank = that string), no card.
            ("Some Old Wallet", ("Some Old Wallet", None)),
            # NULL -> NULL bank, NULL card.
            (None, (None, None)),
        ],
    )
    def test_splits_each_rule(self, label: str | None, expected: tuple[str | None, str | None]):
        """
        GIVEN a stored ``payment_method`` label
        WHEN it is split into ``(bank, card)``
        THEN the normalized bank and the trimmed card detail match the ADR-117 rule
        """
        # WHEN / THEN
        assert split_bank_and_card(label) == expected
