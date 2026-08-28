"""End-to-end tests for the receivable income-match reader over real SQLite (ADR-207).

The REST route for match suggestions lands in a later slice, so these drive the REAL
``SqlAlchemyReceivableMatchReader`` on in-memory async SQLite (ADR-019/032), seeding
people, items, income transactions and claiming payments directly through a real session.
That genuinely exercises the three ADR-207 SQL boundaries — the owner scope, the
earliest-item date window, and the claimed-income exclusion — end to end, and confirms the
reader composes the pure matcher's ranking. Cross-tenant isolation uses the second stub
identity (ADR-113).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.receivable_matching_queries import SqlAlchemyReceivableMatchReader
from margen_api.bootstrap import ApplicationContainer
from margen_api.domain.models.value_objects import Currency, Kind, PaymentSource
from margen_api.service_layer.receivable_matcher import IncomeMatch
from tests.conftest import STUB_USER_ID, STUB_USER_ID_B

_A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
_EARLIEST = date(2026, 8, 10)


def _person_record(user_id: str, name: str) -> PersonRecord:
    """Build a person row with a client-side id (server-default UUIDs skip SQLite)."""
    record = PersonRecord()
    record.id = uuid4()
    record.user_id = UUID(user_id)
    record.name = name
    record.created_at = _A_TIME
    return record


def _item_record(person_id: UUID, occurred_on: date) -> ReceivableItemRecord:
    """Build a receivable item row for a person, dated ``occurred_on``."""
    record = ReceivableItemRecord()
    record.id = uuid4()
    record.person_id = person_id
    record.occurred_on = occurred_on
    record.amount = Decimal("1000.00")
    record.detail = None
    record.created_at = _A_TIME
    return record


def _income_record(user_id: str, name: str, occurred_on: date) -> TransactionRecord:
    """Build a ``kind='income'`` transaction row with a client-side id."""
    record = TransactionRecord()
    record.id = uuid4()
    record.user_id = UUID(user_id)
    record.occurred_on = occurred_on
    record.name = name
    record.kind = Kind.INCOME.value
    record.amount = Decimal("1000.00")
    record.currency = Currency.ARS.value
    record.created_at = _A_TIME
    record.updated_at = _A_TIME
    return record


def _matched_payment(person_id: UUID, income_id: UUID) -> ReceivablePaymentRecord:
    """Build a payment that CLAIMS an income (links matched_income_transaction_id)."""
    record = ReceivablePaymentRecord()
    record.id = uuid4()
    record.person_id = person_id
    record.occurred_on = _EARLIEST
    record.amount = Decimal("1000.00")
    record.source = PaymentSource.MATCHED_INCOME.value
    record.matched_income_transaction_id = income_id
    record.created_at = _A_TIME
    return record


async def _suggest(container: ApplicationContainer, person_id: UUID, user_id: str) -> list[IncomeMatch]:
    """Read income suggestions for a person through the REAL reader over real SQLite."""
    session = container.session_factory()
    try:
        return await SqlAlchemyReceivableMatchReader(session).suggest_income_matches(person_id, user_id)
    finally:
        await session.close()


class TestRankingAndThreshold:
    """The reader returns the matching incomes ranked, and drops the unrelated ones."""

    async def test_suggests_only_name_matching_incomes(self, container: ApplicationContainer):
        """
        GIVEN a person "Juan" with an item and two incomes — one named for Juan, one not
        WHEN suggestions are read
        THEN only the name-matching income is returned
        """
        # GIVEN
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            match = _income_record(STUB_USER_ID, "Transferencia Juan Perez", _EARLIEST)
            miss = _income_record(STUB_USER_ID, "Gimnasio Boca", _EARLIEST)
            session.add_all([person, _item_record(person.id, _EARLIEST), match, miss])
            await session.commit()
            person_id, match_id = person.id, match.id
        finally:
            await session.close()

        # WHEN
        suggestions = await _suggest(container, person_id, STUB_USER_ID)

        # THEN
        assert [income.candidate.transaction_id for income in suggestions] == [match_id]
        assert suggestions[0].score >= 0.6


class TestDateWindow:
    """Only incomes on or after the person's earliest item date are candidates (ADR-207)."""

    async def test_income_before_earliest_item_is_excluded_boundary_is_inclusive(self, container: ApplicationContainer):
        """
        GIVEN incomes one day before, exactly on, and after the earliest item date
        WHEN suggestions are read
        THEN the before-window income is excluded and the on/after ones are included
        """
        # GIVEN — the person's earliest item anchors the window at _EARLIEST.
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            before = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST.replace(day=9))
            on_boundary = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST)
            after = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST.replace(day=20))
            session.add_all([person, _item_record(person.id, _EARLIEST), before, on_boundary, after])
            await session.commit()
            person_id = person.id
            included = {on_boundary.id, after.id}
        finally:
            await session.close()

        # WHEN
        suggestions = await _suggest(container, person_id, STUB_USER_ID)

        # THEN — the boundary date is inclusive; the earlier income is gone.
        assert {income.candidate.transaction_id for income in suggestions} == included

    async def test_person_with_no_items_yields_no_suggestions(self, container: ApplicationContainer):
        """
        GIVEN a person with no items (no date window) but a name-matching income
        WHEN suggestions are read
        THEN nothing is suggested (no receivable to match against)
        """
        # GIVEN
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            session.add_all([person, _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST)])
            await session.commit()
            person_id = person.id
        finally:
            await session.close()

        # WHEN / THEN
        assert await _suggest(container, person_id, STUB_USER_ID) == []


class TestClaimedExclusion:
    """An income already linked to a payment is never re-suggested (ADR-207)."""

    async def test_claimed_income_is_not_suggested(self, container: ApplicationContainer):
        """
        GIVEN two matching incomes, one already claimed by a matched payment
        WHEN suggestions are read
        THEN only the unclaimed income is suggested
        """
        # GIVEN
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            claimed = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST)
            unclaimed = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST.replace(day=20))
            session.add_all([person, _item_record(person.id, _EARLIEST), claimed, unclaimed])
            await session.flush()
            session.add(_matched_payment(person.id, claimed.id))
            await session.commit()
            person_id, unclaimed_id = person.id, unclaimed.id
        finally:
            await session.close()

        # WHEN
        suggestions = await _suggest(container, person_id, STUB_USER_ID)

        # THEN
        assert [income.candidate.transaction_id for income in suggestions] == [unclaimed_id]


class TestOwnerScoping:
    """Every candidate income and the person itself are owner-scoped (ADR-108, ADR-130)."""

    async def test_only_the_owners_income_is_considered(self, container: ApplicationContainer):
        """
        GIVEN user A and user B each own an identically-named matching income
        WHEN A's suggestions are read
        THEN only A's income is returned (B's never leaks in)
        """
        # GIVEN
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            a_income = _income_record(STUB_USER_ID, "Juan Perez", _EARLIEST)
            b_income = _income_record(STUB_USER_ID_B, "Juan Perez", _EARLIEST)
            session.add_all([person, _item_record(person.id, _EARLIEST), a_income, b_income])
            await session.commit()
            person_id, a_income_id = person.id, a_income.id
        finally:
            await session.close()

        # WHEN
        suggestions = await _suggest(container, person_id, STUB_USER_ID)

        # THEN
        assert [income.candidate.transaction_id for income in suggestions] == [a_income_id]

    async def test_foreign_person_yields_no_suggestions(self, container: ApplicationContainer):
        """
        GIVEN a person owned by user A
        WHEN user B reads that person's suggestions
        THEN nothing is returned (existence is never leaked, ADR-111)
        """
        # GIVEN
        session = container.session_factory()
        try:
            person = _person_record(STUB_USER_ID, "Juan")
            session.add_all([person, _item_record(person.id, _EARLIEST)])
            await session.commit()
            person_id = person.id
        finally:
            await session.close()

        # WHEN / THEN
        assert await _suggest(container, person_id, STUB_USER_ID_B) == []

    async def test_unknown_person_yields_no_suggestions(self, container: ApplicationContainer):
        """
        GIVEN no person with a random id
        WHEN suggestions are read
        THEN nothing is returned
        """
        # WHEN / THEN
        assert await _suggest(container, uuid4(), STUB_USER_ID) == []
