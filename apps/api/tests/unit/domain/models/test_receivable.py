"""Unit tests for the receivables aggregates and their factories (ADR-204).

These exercise the per-row domain invariants (non-empty person name, positive money
magnitudes), the lenient normalization (Decimal coercion, blank-detail-to-None), and the
``PaymentSource`` value-object parsing plus identity/timestamp generation. They use plain
Python objects only — no database, no I/O.

Scope note: this is the MINIMAL domain coverage for the data-model foundation task.
Service/handler/repository and e2e tests (create/rename/delete person, allocation
over-payment warning per ADR-206, matched-income confirm per ADR-207, and the ADR-205
net-worth-isolation regression test) are DEFERRED to the later slices of the feature.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.exceptions import (
    EmptyNameError,
    InvalidAmountError,
    UnknownPaymentSourceError,
)
from margen_api.domain.models.receivable import (
    build_person,
    build_receivable_allocation,
    build_receivable_item,
    build_receivable_payment,
)
from margen_api.domain.models.value_objects import PaymentSource

A_USER = "00000000-0000-4000-8000-000000000001"
A_DATE = date(2026, 8, 1)


class TestPerson:
    """A person is the receivables aggregate root with a required name (ADR-204)."""

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a build request with a whitespace-only name
        WHEN the person is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            build_person(name="   ", user_id=A_USER)

    async def test_name_is_trimmed(self):
        """
        GIVEN a build request whose name has surrounding whitespace
        WHEN the person is built
        THEN the stored name is trimmed
        """
        # WHEN
        person = build_person(name="  Juan  ", user_id=A_USER)

        # THEN
        assert person.name == "Juan"

    async def test_generates_id_and_timestamp_when_omitted(self):
        """
        GIVEN a build request without an explicit id or timestamp
        WHEN the person is built
        THEN a UUID identity and a creation timestamp are generated
        """
        # WHEN
        person = build_person(name="Juan", user_id=A_USER)

        # THEN
        assert isinstance(person.id, UUID)
        assert isinstance(person.created_at, datetime)
        assert person.user_id == A_USER

    async def test_injected_identity_and_timestamp_are_preserved(self):
        """
        GIVEN explicit id and timestamp (as the handler injects)
        WHEN the person is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        person_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        person = build_person(name="Juan", user_id=A_USER, person_id=person_id, created_at=moment)

        # THEN
        assert person.id == person_id
        assert person.created_at == moment


class TestReceivableItem:
    """An item is a positive-amount itemized debt with an optional justification (ADR-204)."""

    async def test_amount_is_coerced_to_decimal(self):
        """
        GIVEN a build request whose amount arrives as a string
        WHEN the item is built
        THEN the stored amount is a Decimal (ADR-025)
        """
        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount="1500.50")  # type: ignore[arg-type]

        # THEN
        assert item.amount == Decimal("1500.50")
        assert isinstance(item.amount, Decimal)

    async def test_decimal_amount_is_kept_as_is(self):
        """
        GIVEN a build request whose amount is already a Decimal
        WHEN the item is built
        THEN the amount is retained unchanged
        """
        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("2000"))

        # THEN
        assert item.amount == Decimal("2000")

    @pytest.mark.parametrize("bad_amount", [Decimal("0"), Decimal("-1")])
    async def test_non_positive_amount_is_rejected(self, bad_amount: Decimal):
        """
        GIVEN a build request with a zero or negative amount
        WHEN the item is built
        THEN an InvalidAmountError carrying the value is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError) as exc_info:
            build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=bad_amount)
        assert exc_info.value.amount == bad_amount

    async def test_blank_detail_becomes_none(self):
        """
        GIVEN a build request with a whitespace-only detail
        WHEN the item is built
        THEN the stored detail is None (blank means absent)
        """
        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"), detail="   ")

        # THEN
        assert item.detail is None

    async def test_detail_is_trimmed_and_kept(self):
        """
        GIVEN a build request with a non-blank detail with surrounding whitespace
        WHEN the item is built
        THEN the trimmed detail is retained
        """
        # WHEN
        item = build_receivable_item(
            person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"), detail="  dinner split  "
        )

        # THEN
        assert item.detail == "dinner split"

    async def test_absent_detail_stays_none(self):
        """
        GIVEN a build request without a detail
        WHEN the item is built
        THEN the detail defaults to None
        """
        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"))

        # THEN
        assert item.detail is None

    async def test_injected_identity_and_timestamp_are_preserved(self):
        """
        GIVEN explicit id and timestamp
        WHEN the item is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        item_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        item = build_receivable_item(
            person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"), item_id=item_id, created_at=moment
        )

        # THEN
        assert item.id == item_id
        assert item.created_at == moment

    async def test_new_item_is_not_pardoned_by_default(self):
        """
        GIVEN a build request without a pardon timestamp
        WHEN the item is built
        THEN it is not pardoned (pardoned_at is None, pardoned is False) (ADR-210)
        """
        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"))

        # THEN
        assert item.pardoned_at is None
        assert item.pardoned is False

    async def test_pardoned_at_marks_the_item_pardoned(self):
        """
        GIVEN a build request carrying a pardon timestamp
        WHEN the item is built
        THEN pardoned_at is preserved and pardoned is derived True (ADR-210)
        """
        # GIVEN
        moment = datetime(2026, 8, 29, tzinfo=UTC)

        # WHEN
        item = build_receivable_item(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("10"), pardoned_at=moment)

        # THEN
        assert item.pardoned_at == moment
        assert item.pardoned is True


class TestReceivablePayment:
    """A payment is a positive-amount payback with a source and optional income link (ADR-204, ADR-207)."""

    async def test_defaults_to_manual_source_with_generated_identity(self):
        """
        GIVEN a build request without a source, id or timestamp
        WHEN the payment is built
        THEN it defaults to a manual source with a generated id, timestamp and no income link
        """
        # WHEN
        payment = build_receivable_payment(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("500"))

        # THEN
        assert payment.source is PaymentSource.MANUAL
        assert payment.matched_income_transaction_id is None
        assert isinstance(payment.id, UUID)
        assert isinstance(payment.created_at, datetime)

    async def test_source_enum_member_is_accepted(self):
        """
        GIVEN a build request whose source is a PaymentSource member with an income link
        WHEN the payment is built
        THEN the source and matched income transaction id are retained
        """
        # GIVEN
        income_id = uuid4()

        # WHEN
        payment = build_receivable_payment(
            person_id=uuid4(),
            occurred_on=A_DATE,
            amount=Decimal("500"),
            source=PaymentSource.MATCHED_INCOME,
            matched_income_transaction_id=income_id,
        )

        # THEN
        assert payment.source is PaymentSource.MATCHED_INCOME
        assert payment.matched_income_transaction_id == income_id

    async def test_source_string_is_parsed(self):
        """
        GIVEN a build request whose source arrives as a string
        WHEN the payment is built
        THEN the source is the matching PaymentSource member
        """
        # WHEN
        payment = build_receivable_payment(
            person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("500"), source="matched_income"
        )

        # THEN
        assert payment.source is PaymentSource.MATCHED_INCOME

    async def test_unknown_source_is_rejected(self):
        """
        GIVEN a build request with an unknown source
        WHEN the payment is built
        THEN an UnknownPaymentSourceError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownPaymentSourceError):
            build_receivable_payment(person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("500"), source="bogus")

    async def test_amount_is_coerced_to_decimal(self):
        """
        GIVEN a build request whose amount arrives as a string
        WHEN the payment is built
        THEN the stored amount is a Decimal (ADR-025)
        """
        # WHEN
        payment = build_receivable_payment(person_id=uuid4(), occurred_on=A_DATE, amount="750.25")  # type: ignore[arg-type]

        # THEN
        assert payment.amount == Decimal("750.25")
        assert isinstance(payment.amount, Decimal)

    @pytest.mark.parametrize("bad_amount", [Decimal("0"), Decimal("-5")])
    async def test_non_positive_amount_is_rejected(self, bad_amount: Decimal):
        """
        GIVEN a build request with a zero or negative amount
        WHEN the payment is built
        THEN an InvalidAmountError is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError):
            build_receivable_payment(person_id=uuid4(), occurred_on=A_DATE, amount=bad_amount)

    async def test_injected_identity_and_timestamp_are_preserved(self):
        """
        GIVEN explicit id and timestamp
        WHEN the payment is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        payment_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        payment = build_receivable_payment(
            person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("500"), payment_id=payment_id, created_at=moment
        )

        # THEN
        assert payment.id == payment_id
        assert payment.created_at == moment


class TestReceivableAllocation:
    """An allocation applies a positive slice of a payment to one item (ADR-204, ADR-206)."""

    async def test_amount_is_coerced_to_decimal(self):
        """
        GIVEN a build request whose amount arrives as a string
        WHEN the allocation is built
        THEN the stored amount is a Decimal (ADR-025)
        """
        # WHEN
        allocation = build_receivable_allocation(payment_id=uuid4(), item_id=uuid4(), amount="300")  # type: ignore[arg-type]

        # THEN
        assert allocation.amount == Decimal("300")
        assert isinstance(allocation.amount, Decimal)

    @pytest.mark.parametrize("bad_amount", [Decimal("0"), Decimal("-1")])
    async def test_non_positive_amount_is_rejected(self, bad_amount: Decimal):
        """
        GIVEN a build request with a zero or negative amount
        WHEN the allocation is built
        THEN an InvalidAmountError is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError):
            build_receivable_allocation(payment_id=uuid4(), item_id=uuid4(), amount=bad_amount)

    async def test_generates_identity_when_omitted_and_preserves_when_injected(self):
        """
        GIVEN build requests with and without an explicit id
        WHEN the allocations are built
        THEN an id is generated when omitted and preserved when injected
        """
        # GIVEN
        allocation_id = uuid4()
        payment_id = uuid4()
        item_id = uuid4()

        # WHEN
        generated = build_receivable_allocation(payment_id=payment_id, item_id=item_id, amount=Decimal("300"))
        injected = build_receivable_allocation(
            payment_id=payment_id, item_id=item_id, amount=Decimal("300"), allocation_id=allocation_id
        )

        # THEN
        assert isinstance(generated.id, UUID)
        assert injected.id == allocation_id
        assert injected.payment_id == payment_id
        assert injected.item_id == item_id
