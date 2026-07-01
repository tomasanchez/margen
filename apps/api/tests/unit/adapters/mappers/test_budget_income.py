"""Unit tests for the budget-income record <-> aggregate mappers (ADR-139, ADR-130).

These exercise the mapping functions directly with plain objects — no session, no
database. They cover the round-trip and the owner-less guard the happy-path flow
never reaches.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.adapters.mappers.budget_income import to_domain, to_record
from margen_api.domain.models.budget_income import build_budget_income
from margen_api.domain.models.value_objects import Currency

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
JUNE = date(2026, 6, 1)


class TestRoundTrip:
    """An income base maps to a record and back, preserving every field."""

    def test_round_trip_preserves_state(self):
        """
        GIVEN a fully-populated income aggregate
        WHEN it is mapped to a record and back
        THEN every field round-trips
        """
        # GIVEN
        income = build_budget_income(
            income_id=uuid4(),
            user_id=A_USER,
            period=JUNE,
            amount=Decimal("1200000"),
            currency=Currency.ARS,
            floor_amount=Decimal("500000"),
            floor_source="computed",
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        rehydrated = to_domain(to_record(income))

        # THEN
        assert rehydrated.amount == Decimal("1200000")
        assert rehydrated.floor_amount == Decimal("500000")
        assert rehydrated.floor_source == "computed"
        assert rehydrated.currency is Currency.ARS
        assert str(rehydrated.user_id) == A_USER


class TestOwnerGuard:
    """The mapper refuses to persist an income base without an owner (ADR-130)."""

    def test_to_record_rejects_missing_user_id(self):
        """
        GIVEN an income aggregate with no owning user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (every write threads the owner, ADR-130)
        """
        # GIVEN
        income = build_budget_income(income_id=uuid4(), user_id=A_USER, period=JUNE, amount=Decimal("1"))
        ownerless = replace(income, user_id=None)

        # WHEN / THEN
        with pytest.raises(ValueError, match="user_id"):
            to_record(ownerless)
