"""Unit tests for the budget record <-> aggregate mappers (ADR-125, ADR-130).

These exercise the mapping functions directly with plain objects — no session, no
database. ``BudgetRecord`` is a plain attribute holder here; we never persist it, so
no engine is involved. They cover the round-trip and the owner-less guard the
happy-path flow never reaches.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.adapters.mappers.budget import to_domain, to_record, update_record
from margen_api.adapters.models.budget import BudgetRecord
from margen_api.domain.models.budget import build_budget
from margen_api.domain.models.value_objects import Currency

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


class TestRoundTrip:
    """A budget maps to a record and back, preserving every field."""

    def test_round_trip_preserves_state(self):
        """
        GIVEN a budget aggregate
        WHEN it is mapped to a record and back to a domain aggregate
        THEN every field is carried over faithfully (ADR-125)
        """
        # GIVEN
        original = build_budget(
            budget_id=uuid4(),
            user_id=A_USER,
            category="Food",
            period=date(2026, 6, 1),
            amount=Decimal("50000.00"),
            currency=Currency.ARS,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        rehydrated = to_domain(to_record(original))

        # THEN
        assert rehydrated.id == original.id
        assert rehydrated.user_id == A_USER
        assert rehydrated.category == "Food"
        assert rehydrated.period == date(2026, 6, 1)
        assert rehydrated.amount == Decimal("50000.00")
        assert rehydrated.currency is Currency.ARS


class TestOwnershipGuard:
    """Persisting an owner-less budget is a programming error (ADR-130)."""

    def test_update_record_rejects_missing_user_id(self):
        """
        GIVEN a budget aggregate with no owning user_id
        WHEN update_record copies it onto a row
        THEN a ValueError is raised (every write threads the owner, ADR-130)
        """
        # GIVEN
        ownerless = build_budget(
            budget_id=uuid4(),
            user_id=None,
            category="Food",
            period=date(2026, 6, 1),
            amount=Decimal("1"),
        )

        # WHEN / THEN
        with pytest.raises(ValueError, match="user_id"):
            update_record(BudgetRecord(), ownerless)
