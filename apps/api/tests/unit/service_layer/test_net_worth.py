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
    InstallmentLiabilityInput,
    build_liabilities,
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

    async def test_default_has_zero_liabilities_and_net_equals_total(self):
        """
        GIVEN accounts but no instalment liabilities supplied
        WHEN net worth is built
        THEN the liabilities reservation is zero and net_after_liabilities equals the total (ADR-180)
        """
        # GIVEN
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100000"))

        # WHEN
        net_worth = build_net_worth([ars], display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN — assets-only total is untouched; the reservation is a zero placeholder object.
        assert net_worth.total == Decimal("100000.00")
        assert net_worth.liabilities.installments == Decimal("0.00")
        assert net_worth.liabilities.cc_balance is None
        assert net_worth.liabilities.other is None
        assert net_worth.liabilities.total == Decimal("0.00")
        assert net_worth.net_after_liabilities == Decimal("100000.00")


def _installment(*, amount: Decimal, currency: Currency, remaining_count: int) -> InstallmentLiabilityInput:
    """Build an instalment liability input for the net-worth reservation (ADR-181)."""
    return InstallmentLiabilityInput(amount=amount, currency=currency, remaining_count=remaining_count)


class TestBuildLiabilities:
    """``build_liabilities`` sums the full remaining instalment tail, converted via MEP (ADR-181, ADR-183)."""

    async def test_tail_is_sum_of_remaining_times_cuota_across_plans(self):
        """
        GIVEN two active ARS instalment plans
        WHEN the liabilities reservation is built
        THEN installments = Σ remaining_count * cuota across both plans (the full tail, ADR-181)
        """
        # GIVEN — 4 cuotas x 500 + 2 cuotas x 1000 = 2000 + 2000 = 4000.
        plans = [
            _installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=4),
            _installment(amount=Decimal("1000"), currency=Currency.ARS, remaining_count=2),
        ]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN
        assert liabilities.installments == Decimal("4000.00")
        assert liabilities.total == Decimal("4000.00")
        assert liabilities.cc_balance is None
        assert liabilities.other is None

    async def test_fully_paid_plan_contributes_zero(self):
        """
        GIVEN a plan whose remaining count is 0 (index == total)
        WHEN the liabilities reservation is built
        THEN it contributes nothing to the tail (ADR-182)
        """
        # GIVEN
        plans = [_installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=0)]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN
        assert liabilities.installments == Decimal("0.00")

    async def test_usd_tail_converts_at_mep_rate(self):
        """
        GIVEN a USD instalment plan and an ARS display currency
        WHEN the liabilities reservation is built at the MEP rate
        THEN the native USD tail is converted to ARS (ADR-183)
        """
        # GIVEN — 3 cuotas x 10 USD = 30 USD; at 1000 ARS/USD = 30,000 ARS.
        plans = [_installment(amount=Decimal("10"), currency=Currency.USD, remaining_count=3)]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN
        assert liabilities.installments == Decimal("30000.00")

    async def test_no_rate_degrades_usd_tail_to_native(self):
        """
        GIVEN a USD instalment plan with no MEP rate available and an ARS display currency
        WHEN the liabilities reservation is built
        THEN the USD tail contributes its native figure (degrade-to-native, ADR-132/183)
        """
        # GIVEN — 2 cuotas x 10 USD = 20; no rate, so it degrades to 20 native.
        plans = [_installment(amount=Decimal("10"), currency=Currency.USD, remaining_count=2)]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=None)

        # THEN
        assert liabilities.installments == Decimal("20.00")


class TestNetWorthWithLiabilities:
    """Net worth carries the liabilities reservation alongside the assets-only total (ADR-180)."""

    async def test_net_after_liabilities_is_total_minus_tail(self):
        """
        GIVEN an ARS account and an active instalment plan
        WHEN net worth is built with the instalment liability
        THEN total stays assets-only and net_after_liabilities = total - installments (ADR-180)
        """
        # GIVEN — 100,000 ARS assets; a 4-cuota x 500 tail = 2,000 liability.
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100000"))
        plans = [_installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=4)]

        # WHEN
        net_worth = build_net_worth(
            [ars],
            display_currency=Currency.ARS,
            mep_rate=_MEP,
            installment_liabilities=plans,
        )

        # THEN — total is unchanged (assets), the reservation is the full tail, net is derived.
        assert net_worth.total == Decimal("100000.00")
        assert net_worth.liabilities.installments == Decimal("2000.00")
        assert net_worth.liabilities.total == Decimal("2000.00")
        assert net_worth.net_after_liabilities == Decimal("98000.00")
