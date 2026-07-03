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
    CcBalanceInput,
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
        GIVEN accounts but no instalment or CC-balance liabilities supplied
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
        # cc_balance is now a real computed figure like installments (ADR-185): zero, not None.
        assert net_worth.liabilities.cc_balance == Decimal("0.00")
        assert net_worth.liabilities.cc_balance_native.ars == Decimal("0.00")
        assert net_worth.liabilities.cc_balance_native.usd == Decimal("0.00")
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
        # No CC balances supplied, so the CC liability is a computed zero (ADR-185).
        assert liabilities.cc_balance == Decimal("0.00")
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

    async def test_native_breakdown_ars_only_tail_is_unconverted(self):
        """
        GIVEN two active ARS instalment plans and a USD display currency with a MEP rate
        WHEN the liabilities reservation is built
        THEN installmentsNative.ars is the UNCONVERTED native ARS tail and usd is zero (ADR-183)
        """
        # GIVEN — 4 x 500 + 2 x 1000 = 4000 native ARS; a USD display + rate must NOT touch native.
        plans = [
            _installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=4),
            _installment(amount=Decimal("1000"), currency=Currency.ARS, remaining_count=2),
        ]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.USD, mep_rate=_MEP)

        # THEN — native stays 4000 ARS (unconverted); the converted figure divides by the rate.
        assert liabilities.installments_native.ars == Decimal("4000.00")
        assert liabilities.installments_native.usd == Decimal("0.00")
        assert liabilities.installments == Decimal("4.00")

    async def test_native_breakdown_usd_only_tail_is_unconverted(self):
        """
        GIVEN a USD instalment plan and an ARS display currency with a MEP rate
        WHEN the liabilities reservation is built
        THEN installmentsNative.usd is the UNCONVERTED native USD tail and ars is zero (ADR-183)
        """
        # GIVEN — 3 x 10 USD = 30 native USD; an ARS display + rate must NOT touch native.
        plans = [_installment(amount=Decimal("10"), currency=Currency.USD, remaining_count=3)]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN — native stays 30 USD (unconverted); the converted figure multiplies by the rate.
        assert liabilities.installments_native.usd == Decimal("30.00")
        assert liabilities.installments_native.ars == Decimal("0.00")
        assert liabilities.installments == Decimal("30000.00")

    async def test_native_breakdown_mixed_tail_groups_by_currency_unconverted(self):
        """
        GIVEN a mix of ARS and USD instalment plans (including a fully-paid one)
        WHEN the liabilities reservation is built
        THEN installmentsNative sums each currency's native tail separately, unconverted (ADR-183)
        """
        # GIVEN — 4 x 500 = 2000 ARS + 3 x 10 = 30 USD; a 0-remaining USD plan contributes nothing.
        plans = [
            _installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=4),
            _installment(amount=Decimal("10"), currency=Currency.USD, remaining_count=3),
            _installment(amount=Decimal("99"), currency=Currency.USD, remaining_count=0),
        ]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP)

        # THEN — native tails grouped by currency, no MEP applied; converted = 2000 + 30x1000 = 32000.
        assert liabilities.installments_native.ars == Decimal("2000.00")
        assert liabilities.installments_native.usd == Decimal("30.00")
        assert liabilities.installments == Decimal("32000.00")


def _cc(*, amount: Decimal, currency: Currency) -> CcBalanceInput:
    """Build a native CC-balance subtotal input for the net-worth reservation (ADR-185)."""
    return CcBalanceInput(amount=amount, currency=currency)


class TestBuildLiabilitiesCcBalance:
    """``build_liabilities`` folds the unpaid CC balance in alongside instalments (ADR-185, ADR-183)."""

    async def test_ars_cc_balance_is_summed_and_added_to_total(self):
        """
        GIVEN two ARS card-balance subtotals and no instalments
        WHEN the liabilities reservation is built
        THEN cc_balance is the ARS sum and total includes it (ADR-185)
        """
        # GIVEN — 3,641.66 + 700 = 4,341.66 outstanding ARS card charges.
        balances = [
            _cc(amount=Decimal("3641.66"), currency=Currency.ARS),
            _cc(amount=Decimal("700"), currency=Currency.ARS),
        ]

        # WHEN
        liabilities = build_liabilities([], display_currency=Currency.ARS, mep_rate=_MEP, cc_balances=balances)

        # THEN
        assert liabilities.cc_balance == Decimal("4341.66")
        assert liabilities.cc_balance_native.ars == Decimal("4341.66")
        assert liabilities.cc_balance_native.usd == Decimal("0.00")
        assert liabilities.installments == Decimal("0.00")
        assert liabilities.total == Decimal("4341.66")

    async def test_usd_cc_balance_converts_at_mep_but_native_is_unconverted(self):
        """
        GIVEN a USD card-balance subtotal and an ARS display currency with a MEP rate
        WHEN the liabilities reservation is built
        THEN cc_balance converts at MEP while cc_balance_native.usd stays unconverted (ADR-183)
        """
        # GIVEN — 100 USD outstanding; at 1000 ARS/USD the converted figure is 100,000 ARS.
        balances = [_cc(amount=Decimal("100"), currency=Currency.USD)]

        # WHEN
        liabilities = build_liabilities([], display_currency=Currency.ARS, mep_rate=_MEP, cc_balances=balances)

        # THEN — converted at MEP; the native breakdown keeps the raw 100 USD for the live rate.
        assert liabilities.cc_balance == Decimal("100000.00")
        assert liabilities.cc_balance_native.usd == Decimal("100.00")
        assert liabilities.cc_balance_native.ars == Decimal("0.00")

    async def test_no_rate_degrades_usd_cc_balance_to_native(self):
        """
        GIVEN a USD card balance with no MEP rate available and an ARS display currency
        WHEN the liabilities reservation is built
        THEN the USD balance contributes its native figure (degrade-to-native, ADR-132/183)
        """
        # GIVEN
        balances = [_cc(amount=Decimal("100"), currency=Currency.USD)]

        # WHEN
        liabilities = build_liabilities([], display_currency=Currency.ARS, mep_rate=None, cc_balances=balances)

        # THEN — degrades to 100 native rather than failing.
        assert liabilities.cc_balance == Decimal("100.00")

    async def test_cc_balance_and_installments_both_enter_total(self):
        """
        GIVEN both an instalment tail and an unpaid CC balance (mixed currencies)
        WHEN the liabilities reservation is built
        THEN total = installments + cc_balance, each converted to the display currency (ADR-185)
        """
        # GIVEN — 4 x 500 ARS tail = 2000; a 10 USD card balance = 10,000 ARS at MEP.
        plans = [_installment(amount=Decimal("500"), currency=Currency.ARS, remaining_count=4)]
        balances = [_cc(amount=Decimal("10"), currency=Currency.USD)]

        # WHEN
        liabilities = build_liabilities(plans, display_currency=Currency.ARS, mep_rate=_MEP, cc_balances=balances)

        # THEN
        assert liabilities.installments == Decimal("2000.00")
        assert liabilities.cc_balance == Decimal("10000.00")
        assert liabilities.total == Decimal("12000.00")


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

    async def test_cc_balance_reduces_net_after_liabilities(self):
        """
        GIVEN an ARS account and an unpaid CC balance passed as a liability
        WHEN net worth is built
        THEN total stays assets-only and net_after_liabilities = total - cc_balance (ADR-185)
        """
        # GIVEN — 100,000 ARS assets; a 4,341.66 ARS outstanding card balance.
        ars = _balance(name="Galicia", currency=Currency.ARS, balance=Decimal("100000"))
        balances = [_cc(amount=Decimal("4341.66"), currency=Currency.ARS)]

        # WHEN
        net_worth = build_net_worth(
            [ars],
            display_currency=Currency.ARS,
            mep_rate=_MEP,
            cc_balance_liabilities=balances,
        )

        # THEN
        assert net_worth.total == Decimal("100000.00")
        assert net_worth.liabilities.cc_balance == Decimal("4341.66")
        assert net_worth.liabilities.total == Decimal("4341.66")
        assert net_worth.net_after_liabilities == Decimal("95658.34")
