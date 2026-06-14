"""Unit tests for transaction value-object helpers (ADR-027).

The known category / payment-method sets are tolerant: unknown strings are
accepted elsewhere, but these predicates report membership.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from margen_api.domain.commands.transaction import CreateTransaction
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import (
    Currency,
    FxRateType,
    Kind,
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
        assert request.to_command().fx_rate_type == FxRateType.MANUAL


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

    async def test_unknown_value(self):
        """
        GIVEN a category outside the known set
        WHEN membership is checked
        THEN it reports False
        """
        # WHEN / THEN
        assert is_known_category("Crypto") is False


class TestKnownPaymentMethod:
    """Membership in the known prototype payment-method set."""

    async def test_known_value(self):
        """
        GIVEN a payment method from the known set
        WHEN membership is checked
        THEN it reports True
        """
        # WHEN / THEN
        assert is_known_payment_method("Mercado Pago") is True

    async def test_unknown_value(self):
        """
        GIVEN a payment method outside the known set
        WHEN membership is checked
        THEN it reports False
        """
        # WHEN / THEN
        assert is_known_payment_method("Cash") is False
