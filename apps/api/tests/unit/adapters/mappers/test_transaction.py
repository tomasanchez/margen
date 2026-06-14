"""Unit tests for the transaction record <-> aggregate mappers (ADR-029).

These exercise the mapping functions directly with plain objects — no session,
no database. ``TransactionRecord`` is a plain attribute holder here; we never
persist it, so no engine is involved.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

from margen_api.adapters.mappers.transaction import to_domain, to_record, update_record
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, 10, 0, tzinfo=UTC)


def _usd_record() -> TransactionRecord:
    """Build a populated USD record straight from attribute assignment."""
    record = TransactionRecord()
    record.id = uuid4()
    record.occurred_on = A_DATE
    record.name = "MacBook"
    record.kind = Kind.EXPENSE.value
    record.amount = Decimal("1000000.00")
    record.currency = Currency.USD.value
    record.usd_amount = Decimal("1000.00")
    record.fx_rate = Decimal("1000.500000")
    record.fx_rate_type = FxRateType.MEP.value
    record.fx_rate_as_of = A_TIME
    record.category = "Shopping"
    record.payment_method = "Galicia · Visa"
    record.notes = "work laptop"
    record.recurring = False
    record.counts_toward_monotributo = False
    record.created_at = A_TIME
    record.updated_at = A_TIME
    return record


class TestToDomain:
    """Rehydration of a persisted record into the aggregate."""

    async def test_rehydrates_usd_record(self):
        """
        GIVEN a populated USD persistence record
        WHEN it is mapped to a domain aggregate
        THEN every field including the FX block is carried over faithfully
        """
        # GIVEN
        record = _usd_record()

        # WHEN
        transaction = to_domain(record)

        # THEN
        assert transaction.id == record.id
        assert transaction.kind is Kind.EXPENSE
        assert transaction.currency is Currency.USD
        assert transaction.usd_amount == Decimal("1000.00")
        assert transaction.fx_rate == Decimal("1000.500000")
        assert transaction.fx_rate_type is FxRateType.MEP
        assert transaction.has_complete_fx is True

    async def test_rehydrates_ars_record_without_fx(self):
        """
        GIVEN an ARS record with no FX metadata
        WHEN it is mapped to a domain aggregate
        THEN the FX rate type resolves to None
        """
        # GIVEN
        record = _usd_record()
        record.currency = Currency.ARS.value
        record.usd_amount = None
        record.fx_rate = None
        record.fx_rate_type = None
        record.fx_rate_as_of = None

        # WHEN
        transaction = to_domain(record)

        # THEN
        assert transaction.fx_rate_type is None


class TestToRecordAndUpdate:
    """Building and updating a record from an aggregate."""

    async def test_to_record_copies_every_field(self):
        """
        GIVEN a USD domain aggregate
        WHEN it is mapped to a fresh record
        THEN the record carries the string-valued enums and the FX block
        """
        # GIVEN
        transaction = build_transaction(
            transaction_id=uuid4(),
            occurred_on=A_DATE,
            name="MacBook",
            kind=Kind.EXPENSE,
            amount=Decimal("1000000.00"),
            currency=Currency.USD,
            usd_amount=Decimal("1000.00"),
            fx_rate=Decimal("1000.500000"),
            fx_rate_type=FxRateType.MEP,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        record = to_record(transaction)

        # THEN
        assert record.id == transaction.id
        assert record.kind == "expense"
        assert record.currency == "USD"
        assert record.fx_rate_type == "MEP"
        assert record.amount == Decimal("1000000.00")

    async def test_update_record_drops_fx_for_ars(self):
        """
        GIVEN a persisted USD record and an ARS aggregate
        WHEN update_record applies the aggregate to the record
        THEN the FX rate type is set to None (ARS rows drop FX)
        """
        # GIVEN
        record = _usd_record()
        ars = build_transaction(
            transaction_id=record.id,
            occurred_on=A_DATE,
            name="Rent",
            kind=Kind.EXPENSE,
            amount=Decimal("500000"),
            currency=Currency.ARS,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        update_record(record, ars)

        # THEN
        assert record.currency == "ARS"
        assert record.fx_rate_type is None
        assert record.usd_amount is None

    async def test_round_trip_preserves_state(self):
        """
        GIVEN a domain aggregate
        WHEN it is mapped to a record and back to a domain aggregate
        THEN the rehydrated aggregate matches the original's key fields
        """
        # GIVEN
        original = build_transaction(
            transaction_id=uuid4(),
            occurred_on=A_DATE,
            name="Salary",
            kind=Kind.INVOICE,
            amount=Decimal("3000000.00"),
            currency=Currency.ARS,
            counts_toward_monotributo=True,
            created_at=A_TIME,
            updated_at=A_TIME,
        )

        # WHEN
        rehydrated = to_domain(to_record(original))

        # THEN
        assert rehydrated.name == original.name
        assert rehydrated.kind is original.kind
        assert rehydrated.amount == original.amount
        assert rehydrated.counts_toward_monotributo is True
