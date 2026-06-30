"""Unit tests for the ``Budget`` aggregate (ADR-125).

Plain-object tests with no I/O: they verify the factory generates identity and
timestamps, the period is normalized to the first of its month (the month-navigator
period, ADR-040), money is coerced to ``Decimal`` (ADR-025), and an unknown currency
is a true invariant violation (ADR-031).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.budget import Budget, build_budget, month_start
from margen_api.domain.models.exceptions import UnknownCurrencyError
from margen_api.domain.models.value_objects import Currency

A_USER = "00000000-0000-4000-8000-000000000001"
A_TIME = datetime(2026, 1, 1, tzinfo=UTC)


class TestMonthStart:
    """``month_start`` collapses any date to the first of its calendar month."""

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (date(2026, 6, 14), date(2026, 6, 1)),
            (date(2026, 6, 1), date(2026, 6, 1)),
            (date(2026, 12, 31), date(2026, 12, 1)),
        ],
    )
    def test_returns_first_of_month(self, value: date, expected: date):
        """
        GIVEN any date within a month
        WHEN month_start is applied
        THEN the first day of that month is returned
        """
        # WHEN / THEN
        assert month_start(value) == expected


class TestBuildBudget:
    """The factory builds a valid, normalized aggregate."""

    def test_generates_identity_and_normalizes_period_and_amount(self):
        """
        GIVEN a target mid-month with an int amount and no explicit id/timestamps
        WHEN build_budget runs
        THEN it has a UUID id, the period is the first of the month, and amount is Decimal
        """
        # WHEN
        budget = build_budget(
            category="Food",
            period=date(2026, 6, 14),
            amount=Decimal("50000"),
            user_id=A_USER,
        )

        # THEN
        assert isinstance(budget.id, UUID)
        assert budget.period == date(2026, 6, 1)
        assert budget.amount == Decimal("50000")
        assert budget.currency is Currency.ARS
        assert budget.user_id == A_USER

    def test_preserves_injected_identity_and_timestamps(self):
        """
        GIVEN explicit id and timestamps (the handler injects them)
        WHEN build_budget runs
        THEN it preserves them rather than generating new ones (ADR-026)
        """
        # GIVEN
        budget_id = uuid4()

        # WHEN
        budget = build_budget(
            budget_id=budget_id,
            category="Rent",
            period=date(2026, 6, 1),
            amount=Decimal("100000"),
            currency="ARS",
            user_id=A_USER,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # THEN
        assert budget.id == budget_id
        assert budget.created_at == A_TIME
        assert budget.updated_at == A_TIME

    def test_coerces_non_decimal_amount(self):
        """
        GIVEN a target amount passed as a string
        WHEN the aggregate is constructed directly
        THEN __post_init__ coerces it to Decimal (ADR-025)
        """
        # WHEN
        budget = Budget(
            id=uuid4(),
            user_id=A_USER,
            category="Transport",
            period=date(2026, 6, 1),
            amount="1234.50",  # type: ignore[arg-type]
        )

        # THEN
        assert budget.amount == Decimal("1234.50")

    def test_unknown_currency_raises(self):
        """
        GIVEN an unknown currency
        WHEN build_budget runs
        THEN UnknownCurrencyError is raised (a true invariant violation, ADR-031)
        """
        # WHEN / THEN
        with pytest.raises(UnknownCurrencyError):
            build_budget(category="Food", period=date(2026, 6, 1), amount=Decimal("1"), currency="EUR")
