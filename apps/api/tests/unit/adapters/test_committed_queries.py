"""Unit tests for the committed-queries adapter helpers (ADR-179).

The reader's SQL is covered end to end by the e2e + integration tiers; this module
covers the PURE per-stream helpers that need no session — the offset-driven expected
figures, the remaining-count floor, the posted-this-month SUM, and the monotributo cuota
lookup (services / goods / unknown-category) driven through a fake repository — so the
engine inputs the adapter builds are asserted in isolation (ADR-032).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.adapters.committed_queries import SqlAlchemyCommittedReader, _month_offset
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from tests.fakes.persistence import FakeMonotributoSnapshotRepository

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _record(*, currency: Currency = Currency.ARS, **overrides: object) -> TransactionRecord:
    """Build a ``TransactionRecord`` stand-in with the fields the pure helpers read.

    The helpers read only plain column attributes, so a detached record (never added to a
    session) is enough to drive them without any I/O.
    """
    defaults: dict[str, object] = {
        "id": uuid4(),
        "occurred_on": date(2026, 5, 1),
        "name": "Movement",
        "kind": Kind.EXPENSE.value,
        "amount": Decimal("500"),
        "currency": currency.value,
        "user_id": uuid4(),
        "created_at": _MOMENT,
        "updated_at": _MOMENT,
    }
    defaults.update(overrides)
    cadence = defaults.get("recurring_cadence")
    if isinstance(cadence, RecurringCadence):
        defaults["recurring_cadence"] = cadence.value
    return TransactionRecord(**defaults)


def _reader(config: dict | None = None) -> SqlAlchemyCommittedReader:
    """Build a session-less reader over a fake monotributo repository for the pure helpers."""
    repo = FakeMonotributoSnapshotRepository({}, config if config is not None else {}, {})
    return SqlAlchemyCommittedReader(session=None, monotributo=repo)  # type: ignore[arg-type]


class TestMonthOffset:
    """``_month_offset`` returns the signed month distance between two YYYY-MM keys."""

    @pytest.mark.parametrize(
        ("from_key", "to_key", "expected"),
        [("2026-05", "2026-06", 1), ("2026-06", "2026-06", 0), ("2026-06", "2026-05", -1), ("2025-12", "2026-03", 3)],
    )
    def test_offsets(self, from_key: str, to_key: str, expected: int):
        """
        GIVEN two YYYY-MM keys
        WHEN the offset is measured
        THEN it is the signed number of calendar months between them
        """
        # WHEN / THEN
        assert _month_offset(from_key, to_key) == expected


class TestSubscriptionExpected:
    """A subscription is expected the target month only when its cadence lands there (ADR-176)."""

    def test_monthly_lands_next_month(self):
        """
        GIVEN a monthly subscription whose latest actual is the prior month
        WHEN the expected-this-month amount is computed for the target month
        THEN it is the stream amount (offset 1, monthly cadence)
        """
        # GIVEN — last actual 2026-05, target 2026-06.
        record = _record(occurred_on=date(2026, 5, 1))

        # WHEN
        expected = _reader()._subscription_expected(
            record, Decimal("100"), cadence=RecurringCadence.MONTHLY, target="2026-06"
        )

        # THEN
        assert expected == Decimal("100")

    def test_none_amount_yields_none(self):
        """
        GIVEN a subscription whose denominated amount is None (missing USD snapshot)
        WHEN the expected-this-month amount is computed
        THEN it is None (excluded)
        """
        # WHEN / THEN
        assert (
            _reader()._subscription_expected(_record(), None, cadence=RecurringCadence.MONTHLY, target="2026-06")
            is None
        )

    def test_quarterly_off_cycle_month_yields_none(self):
        """
        GIVEN a quarterly subscription whose target-month offset is not a multiple of 3
        WHEN the expected-this-month amount is computed
        THEN nothing is expected (off-cycle)
        """
        # GIVEN — last actual 2026-05, target 2026-06 (offset 1, not a multiple of 3).
        record = _record(occurred_on=date(2026, 5, 1))

        # WHEN / THEN
        assert (
            _reader()._subscription_expected(
                record, Decimal("100"), cadence=RecurringCadence.QUARTERLY, target="2026-06"
            )
            is None
        )


class TestInstallmentExpected:
    """An instalment cuota is expected the target month only within its remaining tail (ADR-176)."""

    def test_within_tail_returns_amount(self):
        """
        GIVEN a plan with a prior-month latest actual and a remaining cuota due the target month
        WHEN the expected-this-month cuota is computed
        THEN it is the cuota amount
        """
        # GIVEN — last actual 2026-05, 2 remaining, target 2026-06 (offset 1).
        record = _record(
            occurred_on=date(2026, 5, 1),
            recurring_cadence=RecurringCadence.INSTALLMENT,
            installments_total=4,
            installments_index=2,
        )

        # WHEN
        expected = _reader()._installment_expected(record, Decimal("500"), target="2026-06")

        # THEN
        assert expected == Decimal("500")

    def test_none_amount_yields_none(self):
        """
        GIVEN an instalment cuota whose denominated amount is None (missing USD snapshot)
        WHEN the expected-this-month cuota is computed
        THEN it is None (excluded)
        """
        # GIVEN
        record = _record(recurring_cadence=RecurringCadence.INSTALLMENT, installments_total=4, installments_index=2)

        # WHEN / THEN
        assert _reader()._installment_expected(record, None, target="2026-06") is None

    def test_no_remaining_yields_none(self):
        """
        GIVEN a fully-paid plan (index == total, 0 remaining)
        WHEN the expected-this-month cuota is computed
        THEN nothing is expected
        """
        # GIVEN
        record = _record(
            occurred_on=date(2026, 5, 1),
            recurring_cadence=RecurringCadence.INSTALLMENT,
            installments_total=4,
            installments_index=4,
        )

        # WHEN / THEN
        assert _reader()._installment_expected(record, Decimal("500"), target="2026-06") is None

    def test_beyond_tail_yields_none(self):
        """
        GIVEN a plan whose remaining tail does not reach the target month
        WHEN the expected-this-month cuota is computed
        THEN nothing is expected (past the tail)
        """
        # GIVEN — last actual 2026-05, 1 remaining, target 2026-08 (offset 3 > remaining).
        record = _record(
            occurred_on=date(2026, 5, 1),
            recurring_cadence=RecurringCadence.INSTALLMENT,
            installments_total=4,
            installments_index=3,
        )

        # WHEN / THEN
        assert _reader()._installment_expected(record, Decimal("500"), target="2026-08") is None


class TestRemainingCount:
    """``_remaining_count`` floors at 0 and yields 0 when the structured fields are missing."""

    def test_structured_fields_give_the_remainder(self):
        """
        GIVEN a plan with total 6 and index 2
        WHEN the remaining count is computed
        THEN it is total - index (4)
        """
        # GIVEN
        record = _record(installments_total=6, installments_index=2)

        # WHEN / THEN
        assert _reader()._remaining_count(record) == 4

    def test_missing_fields_yield_zero(self):
        """
        GIVEN a plan with no structured total/index (a lone marker)
        WHEN the remaining count is computed
        THEN it is 0 (no known tail)
        """
        # WHEN / THEN
        assert _reader()._remaining_count(_record()) == 0


class TestNativeAmountAndPosted:
    """Denomination + posted-this-month SUM over a stream's rows (ADR-168/179)."""

    def test_usd_denomination_uses_snapshot(self):
        """
        GIVEN a USD row carrying a usd_amount snapshot
        WHEN it is denominated on the USD path
        THEN the snapshot is used; a snapshotless USD row is excluded (None)
        """
        # GIVEN
        snapshotted = _record(currency=Currency.USD, usd_amount=Decimal("20"), amount=Decimal("20000"))
        bare = _record(currency=Currency.USD, amount=Decimal("20000"))

        # WHEN / THEN
        reader = _reader()
        assert reader._denominated_amount(snapshotted, is_usd=True) == Decimal("20")
        assert reader._denominated_amount(bare, is_usd=True) is None

    def test_posted_this_month_sums_matching_rows(self):
        """
        GIVEN two rows of the same (name, category) stream, one this month and one prior
        WHEN posted-this-month is computed for the target month
        THEN only the target-month row is summed; a stream with no this-month row is None
        """
        # GIVEN — key ("Rent","Housing"): a 2026-06 row (posted) and a 2026-05 row (prior).
        rows = [
            _record(name="Rent", category="Housing", occurred_on=date(2026, 6, 1), amount=Decimal("300")),
            _record(name="Rent", category="Housing", occurred_on=date(2026, 5, 1), amount=Decimal("100")),
            _record(name="Other", category="Misc", occurred_on=date(2026, 6, 1), amount=Decimal("999")),
        ]
        reader = _reader()

        # WHEN / THEN — the target-month "Rent" row is paid; a non-matching key is None.
        assert reader._posted_this_month(rows, ("Rent", "Housing"), target="2026-06", is_usd=False) == Decimal("300")
        assert reader._posted_this_month(rows, ("Gym", "Health"), target="2026-06", is_usd=False) is None

    def test_posted_this_month_skips_snapshotless_usd_rows(self):
        """
        GIVEN a this-month USD row with NO snapshot
        WHEN posted-this-month is computed on the USD path
        THEN it cannot be denominated and the stream reports no posted amount (None)
        """
        # GIVEN
        rows = [_record(name="Cloud", category="Tech", occurred_on=date(2026, 6, 1), currency=Currency.USD)]

        # WHEN / THEN
        assert _reader()._posted_this_month(rows, ("Cloud", "Tech"), target="2026-06", is_usd=True) is None


class TestMonotributoCuota:
    """The configured cuota is resolved from the scale, or None for absent/unknown config (ADR-177)."""

    async def test_services_cuota_when_configured(self):
        """
        GIVEN a configured category with the services activity type
        WHEN the cuota is resolved
        THEN a positive services cuota is returned
        """
        # GIVEN
        reader = _reader({"current_category": "A", "activity_type": "services"})

        # WHEN
        cuota = await reader._monotributo_cuota("u1")

        # THEN
        assert cuota is not None
        assert cuota > Decimal(0)

    async def test_bienes_cuota_when_goods_activity(self):
        """
        GIVEN a configured category with the goods (bienes) activity type
        WHEN the cuota is resolved
        THEN the goods cuota column is used (ADR-046)
        """
        # GIVEN
        reader = _reader({"current_category": "H", "activity_type": "bienes"})

        # WHEN
        cuota = await reader._monotributo_cuota("u1")

        # THEN
        assert cuota is not None
        assert cuota > Decimal(0)

    async def test_no_config_yields_none(self):
        """
        GIVEN no configured category
        WHEN the cuota is resolved
        THEN None is returned (the tax leg is omitted)
        """
        # WHEN / THEN
        assert await _reader({})._monotributo_cuota("u1") is None

    async def test_unknown_category_yields_none(self):
        """
        GIVEN a configured category that is not in the scale table
        WHEN the cuota is resolved
        THEN None is returned rather than raising (ADR-177)
        """
        # GIVEN — a bogus category token the scale does not know.
        reader = _reader({"current_category": "ZZ", "activity_type": "services"})

        # WHEN / THEN
        assert await reader._monotributo_cuota("u1") is None
