"""Unit tests for the ``Debt`` aggregate and ``build_debt`` (ADR-187).

These exercise the domain invariants (non-empty name, non-negative balance, known
currency) and the value-object parsing plus the optional YAGNI extension points. They use
plain Python objects only — no database, no I/O.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.debt import Debt, build_debt
from margen_api.domain.models.exceptions import EmptyNameError, InvalidBalanceError, UnknownCurrencyError
from margen_api.domain.models.value_objects import Currency

A_USER = "00000000-0000-4000-8000-000000000001"


def _build(**overrides: object) -> Debt:
    """Build a valid debt, letting individual tests override fields."""
    defaults: dict[str, object] = {
        "name": "Banco Nación loan",
        "currency": Currency.ARS,
        "current_balance": Decimal("100000"),
        "user_id": A_USER,
    }
    defaults.update(overrides)
    return build_debt(**defaults)  # type: ignore[arg-type]


class TestNameInvariant:
    """The display name must be a non-empty label (mirrors ADR-024)."""

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a build request with a whitespace-only name
        WHEN the debt is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name="   ")

    async def test_name_is_trimmed(self):
        """
        GIVEN a build request whose name has surrounding whitespace
        WHEN the debt is built
        THEN the stored name is trimmed
        """
        # WHEN
        debt = _build(name="  Car loan  ")

        # THEN
        assert debt.name == "Car loan"


class TestBalanceInvariant:
    """``current_balance`` is a non-negative money magnitude (ADR-187)."""

    async def test_negative_balance_is_rejected(self):
        """
        GIVEN a build request with a negative current balance
        WHEN the debt is built
        THEN an InvalidBalanceError carrying the value is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidBalanceError) as exc_info:
            _build(current_balance=Decimal("-1"))
        assert exc_info.value.balance == Decimal("-1")

    async def test_zero_balance_is_allowed(self):
        """
        GIVEN a build request with a zero current balance
        WHEN the debt is built
        THEN it is accepted (a fully-paid debt is a valid record)
        """
        # WHEN
        debt = _build(current_balance=Decimal("0"))

        # THEN
        assert debt.current_balance == Decimal("0")

    async def test_balance_is_coerced_to_decimal(self):
        """
        GIVEN a build request whose balance arrives as a string
        WHEN the debt is built
        THEN the stored balance is a Decimal (ADR-025)
        """
        # WHEN
        debt = _build(current_balance="250.50")

        # THEN
        assert debt.current_balance == Decimal("250.50")
        assert isinstance(debt.current_balance, Decimal)


class TestOptionalExtensionPoints:
    """``monthly_minimum`` and ``rate`` are optional, behaviourless (ADR-187)."""

    async def test_defaults_are_none(self):
        """
        GIVEN a build request without the extension points
        WHEN the debt is built
        THEN monthly_minimum and rate default to None
        """
        # WHEN
        debt = _build()

        # THEN
        assert debt.monthly_minimum is None
        assert debt.rate is None

    async def test_present_extension_points_are_coerced_to_decimal(self):
        """
        GIVEN a build request with string extension points
        WHEN the debt is built
        THEN both are coerced to Decimal (ADR-025)
        """
        # WHEN
        debt = _build(monthly_minimum="5000", rate="49.5")

        # THEN
        assert debt.monthly_minimum == Decimal("5000")
        assert debt.rate == Decimal("49.5")
        assert isinstance(debt.monthly_minimum, Decimal)
        assert isinstance(debt.rate, Decimal)


class TestCurrencyParsing:
    """``currency`` parses known strings and rejects unknowns (ADR-183)."""

    async def test_currency_parses_from_string(self):
        """
        GIVEN a build request whose currency arrives as a string
        WHEN the debt is built
        THEN the currency is the matching Currency member
        """
        # WHEN
        debt = _build(currency="USD")

        # THEN
        assert debt.currency is Currency.USD

    async def test_unknown_currency_is_rejected(self):
        """
        GIVEN a build request with an unknown currency
        WHEN the debt is built
        THEN an UnknownCurrencyError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownCurrencyError):
            _build(currency="EUR")


class TestIdentityAndTimestamps:
    """The factory generates identity/timestamps when not injected (ADR-026)."""

    async def test_generates_id_and_timestamps_when_omitted(self):
        """
        GIVEN a build request without an explicit id or timestamps
        WHEN the debt is built
        THEN a UUID identity and creation/update timestamps are generated
        """
        # WHEN
        debt = _build()

        # THEN
        assert isinstance(debt.id, UUID)
        assert isinstance(debt.created_at, datetime)
        assert isinstance(debt.updated_at, datetime)

    async def test_injected_identity_and_timestamps_are_preserved(self):
        """
        GIVEN explicit id and timestamps (as the handler injects)
        WHEN the debt is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        debt_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        debt = _build(debt_id=debt_id, created_at=moment, updated_at=moment)

        # THEN
        assert debt.id == debt_id
        assert debt.created_at == moment
        assert debt.updated_at == moment
