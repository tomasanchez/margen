"""Unit tests for the pure net-worth assembly (ADR-122, ADR-123).

These exercise the cross-currency conversion via the MEP rate and the total
summation with no I/O. The mixed ARS+USD scenario is the core of ADR-123: a USD
account's native balance is converted to the display currency before it joins the
total. The no-rate path proves the documented degrade-to-native fallback (ADR-132).
"""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

from margen_api.domain.models.value_objects import Currency, InstitutionType
from margen_api.service_layer.net_worth import (
    AccountBalanceInput,
    build_net_worth,
    convert,
)

# 1 USD = 1000 ARS (MEP), a round figure that keeps the arithmetic obvious.
_MEP = Decimal("1000")


def _balance(*, name: str, currency: Currency, balance: Decimal) -> AccountBalanceInput:
    """Build an account-balance input carrying denormalized institution data (ADR-134)."""
    return AccountBalanceInput(
        id=uuid4(),
        institution_id=uuid4(),
        institution_name=name,
        type=InstitutionType.BANK,
        currency=currency,
        balance=balance,
    )


class TestConvert:
    """``convert`` applies the ARS-per-USD MEP rate, or degrades to native."""

    async def test_same_currency_is_identity(self):
        """
        GIVEN an amount whose source and target currency match
        WHEN it is converted
        THEN the amount is returned unchanged
        """
        # WHEN / THEN
        assert convert(Decimal("500"), Currency.ARS, Currency.ARS, _MEP) == Decimal("500")

    async def test_usd_to_ars_multiplies_by_rate(self):
        """
        GIVEN a USD amount and an ARS display currency
        WHEN it is converted at the MEP rate
        THEN the amount is multiplied by the rate (ADR-123)
        """
        # WHEN / THEN
        assert convert(Decimal("3"), Currency.USD, Currency.ARS, _MEP) == Decimal("3000")

    async def test_ars_to_usd_divides_by_rate(self):
        """
        GIVEN an ARS amount and a USD display currency
        WHEN it is converted at the MEP rate
        THEN the amount is divided by the rate (ADR-123)
        """
        # WHEN / THEN
        assert convert(Decimal("2000"), Currency.ARS, Currency.USD, _MEP) == Decimal("2")

    async def test_missing_rate_degrades_to_native(self):
        """
        GIVEN a cross-currency conversion with no available MEP rate
        WHEN it is converted
        THEN the amount is returned unchanged (degrade to native, ADR-132)
        """
        # WHEN / THEN
        assert convert(Decimal("3"), Currency.USD, Currency.ARS, None) == Decimal("3")

    async def test_non_positive_rate_degrades_to_native(self):
        """
        GIVEN a cross-currency conversion with a non-positive rate
        WHEN it is converted
        THEN the amount is returned unchanged rather than dividing by zero (ADR-132)
        """
        # WHEN / THEN
        assert convert(Decimal("3"), Currency.USD, Currency.ARS, Decimal("0")) == Decimal("3")


class TestBuildNetWorth:
    """``build_net_worth`` sums converted balances and keeps the breakdown."""

    async def test_mixed_currency_total_uses_mep_fx(self):
        """
        GIVEN one ARS account and one USD account
        WHEN net worth is built with an ARS display currency and a MEP rate
        THEN the USD balance is converted and added to the ARS balance (ADR-123)
        """
        # GIVEN — 100,000 ARS + 50 USD; at 1000 ARS/USD the USD account is 50,000 ARS.
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100000"))
        usd = _balance(name="Deel USD", currency=Currency.USD, balance=Decimal("50"))

        # WHEN
        net_worth = build_net_worth([ars, usd], display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN
        assert net_worth.currency is Currency.ARS
        assert net_worth.total == Decimal("150000")
        # The breakdown keeps each account's native balance, converted value and institution.
        by_id = {item.id: item for item in net_worth.accounts}
        assert by_id[ars.id].balance == Decimal("100000")
        assert by_id[ars.id].balance_converted == Decimal("100000")
        assert by_id[ars.id].institution_name == "Galicia"
        assert by_id[ars.id].institution_id == ars.institution_id
        assert by_id[usd.id].balance == Decimal("50")
        assert by_id[usd.id].balance_converted == Decimal("50000")

    async def test_usd_display_currency_converts_ars_accounts(self):
        """
        GIVEN an ARS account and a USD display currency
        WHEN net worth is built at the MEP rate
        THEN the ARS balance is converted to USD in the total (ADR-123)
        """
        # GIVEN
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100000"))

        # WHEN
        net_worth = build_net_worth([ars], display_currency=Currency.USD, mep_rate=_MEP)

        # THEN
        assert net_worth.currency is Currency.USD
        assert net_worth.total == Decimal("100")

    async def test_no_rate_keeps_native_balances_in_total(self):
        """
        GIVEN a mixed-currency portfolio with no MEP rate available
        WHEN net worth is built
        THEN each balance contributes its native figure (degrade-to-native, ADR-132)
        """
        # GIVEN
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100"))
        usd = _balance(name="Deel USD", currency=Currency.USD, balance=Decimal("5"))

        # WHEN
        net_worth = build_net_worth([ars, usd], display_currency=Currency.ARS, mep_rate=None)

        # THEN — 100 + 5 with no conversion (a deliberately approximate fallback).
        assert net_worth.total == Decimal("105")

    async def test_empty_portfolio_is_zero(self):
        """
        GIVEN no accounts
        WHEN net worth is built
        THEN the total is zero and the breakdown is empty
        """
        # WHEN
        net_worth = build_net_worth([], display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN
        assert net_worth.total == Decimal("0")
        assert net_worth.accounts == []
