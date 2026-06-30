"""Unit tests for transaction value-object helpers (ADR-027).

The known category / payment-method sets are tolerant: unknown strings are
accepted elsewhere, but these predicates report membership.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from margen_api.domain.commands.transaction import CreateTransaction
from margen_api.domain.models.exceptions import UnknownBudgetKindError
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import (
    BudgetKind,
    Currency,
    FxRateType,
    Kind,
    is_essential,
    is_known_category,
    is_known_payment_method,
)
from margen_api.entrypoint.transactions_schemas import TransactionCreateRequest


class TestFxRateType:
    """The FX-rate source enum carries the ADR-044 members without a migration."""

    async def test_exposes_the_adr_044_members(self):
        """
        GIVEN the broadened FxRateType enum (ADR-044)
        WHEN its members are inspected
        THEN MEP plus the manual / official / configured-default sources exist
        """
        # WHEN / THEN
        assert {member.value for member in FxRateType} == {
            "MEP",
            "manual",
            "official",
            "configured_default",
        }

    async def test_manual_resolves_from_its_string_value(self):
        """
        GIVEN the 'manual' rate-source string the frontend sends on override
        WHEN it is coerced to a FxRateType
        THEN the MANUAL member is returned
        """
        # WHEN / THEN
        assert FxRateType("manual") is FxRateType.MANUAL

    async def test_usd_domain_transaction_round_trips_manual_source(self):
        """
        GIVEN a USD transaction whose rate source is the manual override
        WHEN the aggregate is built
        THEN the manual FxRateType is preserved (not defaulted to MEP)
        """
        # WHEN
        transaction = build_transaction(
            occurred_on=date(2026, 6, 14),
            name="Freelance payout",
            kind=Kind.INCOME,
            amount=Decimal("1200000"),
            currency=Currency.USD,
            usd_amount=Decimal("1000"),
            fx_rate=Decimal("1200"),
            fx_rate_type="manual",
        )

        # THEN
        assert transaction.fx_rate_type is FxRateType.MANUAL

    async def test_create_command_accepts_manual_source(self):
        """
        GIVEN a CreateTransaction command for a USD row with a manual rate
        WHEN the command is constructed
        THEN the manual FxRateType validates and is carried through
        """
        # WHEN
        command = CreateTransaction(
            occurred_on=date(2026, 6, 14),
            name="Freelance payout",
            kind=Kind.INCOME,
            amount=Decimal("1200000"),
            currency=Currency.USD,
            usd_amount=Decimal("1000"),
            fx_rate=Decimal("1200"),
            fx_rate_type="manual",
            user_id="00000000-0000-4000-8000-000000000001",
        )

        # THEN
        assert command.fx_rate_type is FxRateType.MANUAL

    async def test_create_request_accepts_manual_source_and_maps_to_command(self):
        """
        GIVEN the camelCase create request a USD override produces
        WHEN it is validated and translated to its command
        THEN fxRateType 'manual' is accepted and round-trips to the command
        """
        # WHEN
        request = TransactionCreateRequest.model_validate(
            {
                "occurredOn": "2026-06-14",
                "name": "Freelance payout",
                "kind": "income",
                "amountNum": "1200000",
                "currency": "USD",
                "usd": "1000",
                "rate": "1200",
                "fxRateType": "manual",
            }
        )

        # THEN
        assert request.fx_rate_type == FxRateType.MANUAL
        assert request.to_command("00000000-0000-4000-8000-000000000001").fx_rate_type == FxRateType.MANUAL


class TestKnownCategory:
    """Membership in the known prototype category set."""

    async def test_known_value(self):
        """
        GIVEN a category from the known set
        WHEN membership is checked
        THEN it reports True
        """
        # WHEN / THEN
        assert is_known_category("Food") is True

    async def test_fees_is_a_known_category(self):
        """
        GIVEN the "Fees" category added for transfer fees (ADR-135)
        WHEN membership is checked
        THEN it reports True (extends the category set of ADR-083)
        """
        # WHEN / THEN
        assert is_known_category("Fees") is True

    async def test_unknown_value(self):
        """
        GIVEN a category outside the known set
        WHEN membership is checked
        THEN it reports False
        """
        # WHEN / THEN
        assert is_known_category("Crypto") is False


class TestKnownPaymentMethod:
    """Membership in the known normalized bank set (ADR-024, ADR-117)."""

    @pytest.mark.parametrize("bank", ["Galicia", "Santander", "Mercado Pago", "Brubank", "Deel", "Transfer"])
    async def test_known_value(self, bank: str):
        """
        GIVEN a normalized bank from the amended known set (ADR-117)
        WHEN membership is checked
        THEN it reports True
        """
        # WHEN / THEN
        assert is_known_payment_method(bank) is True

    @pytest.mark.parametrize("value", ["Cash", "Galicia · Visa", "Santander VISA ·5771"])
    async def test_unknown_value(self, value: str):
        """
        GIVEN a value outside the amended bank set — incl. old composed labels (ADR-117)
        WHEN membership is checked
        THEN it reports False
        """
        # WHEN / THEN
        assert is_known_payment_method(value) is False


class TestBudgetKind:
    """``BudgetKind`` is a closed enum parsed like ``Kind`` / ``Currency`` (ADR-138)."""

    def test_parses_a_member_and_a_string(self):
        """
        GIVEN a member and a matching string
        WHEN parsed
        THEN both coerce to the member
        """
        # WHEN / THEN
        assert BudgetKind.parse(BudgetKind.SPEND) is BudgetKind.SPEND
        assert BudgetKind.parse("saving") is BudgetKind.SAVING

    def test_unknown_kind_raises(self):
        """
        GIVEN an out-of-set kind
        WHEN parsed
        THEN UnknownBudgetKindError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownBudgetKindError):
            BudgetKind.parse("invest")


class TestIsEssential:
    """``is_essential`` classifies the locked essential spend categories (ADR-143)."""

    @pytest.mark.parametrize("category", ["Housing", "Rent", "Food", "Transport", "Health", "Education", "Taxes"])
    def test_essential_categories(self, category: str):
        """
        GIVEN an essential category (incl. the legacy Rent alias)
        WHEN classified
        THEN it reports essential
        """
        # WHEN / THEN
        assert is_essential(category) is True

    @pytest.mark.parametrize("category", ["Entertainment", "Shopping", "Subscriptions", "Other"])
    def test_non_essential_categories(self, category: str):
        """
        GIVEN a discretionary category
        WHEN classified
        THEN it reports non-essential
        """
        # WHEN / THEN
        assert is_essential(category) is False


class TestKnownCategoryDelta:
    """ADR-140: Housing + Education are known; Rent is retained as an alias."""

    @pytest.mark.parametrize("category", ["Housing", "Education", "Rent"])
    def test_mvp_category_delta(self, category: str):
        """
        GIVEN the MVP category delta
        WHEN membership is checked
        THEN Housing/Education are known and Rent is retained
        """
        # WHEN / THEN
        assert is_known_category(category) is True
