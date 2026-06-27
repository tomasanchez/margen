"""Unit tests for the ``Account`` aggregate and ``build_account`` (ADR-122, ADR-123).

These exercise the domain invariants (non-empty name, known type/currency), the
lenient opening-balance normalization (may be zero or negative, ADR-122) and the
value-object parsing. They use plain Python objects only — no database, no I/O.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.account import ZERO, Account, build_account
from margen_api.domain.models.exceptions import (
    EmptyNameError,
    UnknownAccountTypeError,
    UnknownCurrencyError,
)
from margen_api.domain.models.value_objects import AccountType, Currency

A_USER = "00000000-0000-4000-8000-000000000001"


def _build(**overrides: object) -> Account:
    """Build a valid account, letting individual tests override fields."""
    defaults: dict[str, object] = {
        "name": "Galicia",
        "type": AccountType.BANK,
        "currency": Currency.ARS,
        "user_id": A_USER,
    }
    defaults.update(overrides)
    return build_account(**defaults)  # type: ignore[arg-type]


class TestNameInvariant:
    """The display name must be a non-empty label (mirrors ADR-024)."""

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a build request with an empty name
        WHEN the account is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name="   ")

    async def test_name_is_trimmed(self):
        """
        GIVEN a build request whose name has surrounding whitespace
        WHEN the account is built
        THEN the stored name is trimmed
        """
        # WHEN
        account = _build(name="  Cash  ")

        # THEN
        assert account.name == "Cash"


class TestTypeAndCurrencyParsing:
    """``type`` and ``currency`` parse known strings and reject unknown ones."""

    async def test_type_parses_from_string(self):
        """
        GIVEN a build request whose type arrives as a string
        WHEN the account is built
        THEN the type is the matching AccountType member
        """
        # WHEN
        account = _build(type="cash")

        # THEN
        assert account.type is AccountType.CASH

    async def test_unknown_type_is_rejected(self):
        """
        GIVEN a build request with an unknown type
        WHEN the account is built
        THEN an UnknownAccountTypeError carrying the value is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownAccountTypeError) as exc_info:
            _build(type="crypto")
        assert exc_info.value.account_type == "crypto"

    async def test_currency_parses_from_string(self):
        """
        GIVEN a build request whose currency arrives as a string
        WHEN the account is built
        THEN the currency is the matching Currency member (ADR-123)
        """
        # WHEN
        account = _build(currency="USD")

        # THEN
        assert account.currency is Currency.USD

    async def test_unknown_currency_is_rejected(self):
        """
        GIVEN a build request with an unknown currency
        WHEN the account is built
        THEN an UnknownCurrencyError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownCurrencyError):
            _build(currency="EUR")


class TestOpeningBalance:
    """The opening balance is money: coerced to Decimal, may be zero or negative."""

    async def test_defaults_to_zero(self):
        """
        GIVEN a build request with no opening balance
        WHEN the account is built
        THEN the opening balance defaults to zero (ADR-124)
        """
        # WHEN
        account = _build()

        # THEN
        assert account.opening_balance == ZERO

    async def test_negative_opening_balance_is_allowed(self):
        """
        GIVEN a card account opened with an outstanding balance
        WHEN the account is built with a negative opening balance
        THEN no invariant rejects it (ADR-122)
        """
        # WHEN
        account = _build(type=AccountType.CARD, opening_balance=Decimal("-5000.00"))

        # THEN
        assert account.opening_balance == Decimal("-5000.00")

    async def test_non_decimal_opening_balance_is_coerced(self):
        """
        GIVEN a build request whose opening balance arrives as a non-Decimal value
        WHEN the account is built
        THEN the opening balance is normalized to a Decimal
        """
        # WHEN
        account = _build(opening_balance="1234.50")

        # THEN
        assert account.opening_balance == Decimal("1234.50")
        assert isinstance(account.opening_balance, Decimal)


class TestIdentityAndTimestamps:
    """The factory generates identity/timestamps when not injected (ADR-026)."""

    async def test_generates_id_and_timestamps_when_omitted(self):
        """
        GIVEN a build request without an explicit id or timestamps
        WHEN the account is built
        THEN a UUID identity and creation/update timestamps are generated
        """
        # WHEN
        account = _build()

        # THEN
        assert isinstance(account.id, UUID)
        assert isinstance(account.created_at, datetime)
        assert isinstance(account.updated_at, datetime)

    async def test_injected_identity_and_timestamps_are_preserved(self):
        """
        GIVEN explicit id and timestamps (as the handler injects)
        WHEN the account is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        account_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        account = _build(account_id=account_id, created_at=moment, updated_at=moment)

        # THEN
        assert account.id == account_id
        assert account.created_at == moment
        assert account.updated_at == moment


class TestAccountTypeParse:
    """``AccountType.parse`` is idempotent on members and rejects unknowns."""

    async def test_parse_passes_through_member(self):
        """
        GIVEN an AccountType member
        WHEN it is parsed
        THEN the same member is returned
        """
        # WHEN / THEN
        assert AccountType.parse(AccountType.CARD) is AccountType.CARD
