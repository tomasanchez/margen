"""Unit tests for transaction value-object helpers (ADR-027).

The known category / payment-method sets are tolerant: unknown strings are
accepted elsewhere, but these predicates report membership.
"""

from __future__ import annotations

from margen_api.domain.models.value_objects import (
    is_known_category,
    is_known_payment_method,
)


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
