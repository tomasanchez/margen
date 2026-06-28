"""Unit tests for the transfer record <-> aggregate mappers (ADR-135).

These exercise the mapping functions directly with plain objects — no session, no
database. ``TransferRecord`` is a plain attribute holder here; we never persist it,
so no engine is involved.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.adapters.mappers.transfer import to_domain, to_record
from margen_api.domain.models.transfer import build_transfer

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, 10, 0, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
A_FROM = UUID("00000000-0000-4000-8000-0000000000a1")
A_TO = UUID("00000000-0000-4000-8000-0000000000a2")


class TestRoundTrip:
    """A transfer maps to a record and back, preserving every field."""

    async def test_round_trip_preserves_state(self):
        """
        GIVEN a cross-currency transfer aggregate with a note
        WHEN it is mapped to a record and back to a domain aggregate
        THEN every field is carried over faithfully (ADR-135)
        """
        # GIVEN
        original = build_transfer(
            transfer_id=uuid4(),
            from_account_id=A_FROM,
            to_account_id=A_TO,
            amount_out=Decimal("100.00"),
            amount_in=Decimal("95000.00"),
            occurred_on=A_DATE,
            note="payout sweep",
            user_id=A_USER,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        rehydrated = to_domain(to_record(original))

        # THEN
        assert rehydrated.id == original.id
        assert rehydrated.from_account_id == A_FROM
        assert rehydrated.to_account_id == A_TO
        assert rehydrated.amount_out == Decimal("100.00")
        assert rehydrated.amount_in == Decimal("95000.00")
        assert rehydrated.occurred_on == A_DATE
        assert rehydrated.note == "payout sweep"
        assert rehydrated.user_id == A_USER

    async def test_to_record_rejects_missing_owner(self):
        """
        GIVEN a transfer aggregate without a user_id (a missed write path)
        WHEN it is mapped to a persistence record
        THEN a ValueError is raised because the column is NOT NULL (ADR-130)
        """
        # GIVEN
        ownerless = build_transfer(
            transfer_id=uuid4(),
            from_account_id=A_FROM,
            to_account_id=A_TO,
            amount_out=Decimal("100"),
            amount_in=Decimal("100"),
            occurred_on=A_DATE,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            to_record(ownerless)
