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

from margen_api.adapters.committed_queries import (
    SqlAlchemyCommittedReader,
    _as_decimal,
    _month_offset,
    _PoolCharge,
    _StreamCandidate,
)
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.forecast_read_models import CommitmentSource
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


class TestAsDecimal:
    """A summed money column is coerced to ``Decimal`` regardless of the driver's type (ADR-025)."""

    def test_decimal_passes_through(self):
        """
        GIVEN a value already a Decimal (asyncpg returns NUMERIC as Decimal)
        WHEN it is coerced
        THEN the same Decimal is returned
        """
        # WHEN / THEN
        assert _as_decimal(Decimal("5000.00")) == Decimal("5000.00")

    def test_float_is_coerced_to_decimal(self):
        """
        GIVEN a float (as SQLite may return for a summed NUMERIC)
        WHEN it is coerced
        THEN a Decimal is returned so the tax-paid SUM stays money-typed (ADR-025)
        """
        # WHEN
        result = _as_decimal(5000.0)

        # THEN
        assert result == Decimal("5000.0")
        assert isinstance(result, Decimal)


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
    """The cuota is resolved from the TARGET MONTH's vintage, or None for absent/unknown config (ADR-177/067)."""

    async def test_services_cuota_when_configured(self):
        """
        GIVEN a configured category with the services activity type
        WHEN the cuota is resolved for a target month
        THEN a positive services cuota is returned
        """
        # GIVEN
        reader = _reader({"current_category": "A", "activity_type": "services"})

        # WHEN
        cuota = await reader._monotributo_cuota("u1", as_of=date(2026, 7, 1))

        # THEN
        assert cuota is not None
        assert cuota > Decimal(0)

    async def test_bienes_cuota_when_goods_activity(self):
        """
        GIVEN a configured category with the goods (bienes) activity type
        WHEN the cuota is resolved for a target month
        THEN the goods cuota column is used (ADR-046)
        """
        # GIVEN
        reader = _reader({"current_category": "H", "activity_type": "bienes"})

        # WHEN
        cuota = await reader._monotributo_cuota("u1", as_of=date(2026, 7, 1))

        # THEN
        assert cuota is not None
        assert cuota > Decimal(0)

    async def test_cuota_resolves_target_month_vintage(self):
        """
        GIVEN a configured services taxpayer and two target months straddling the Aug-1 2026
              ARCA vintage boundary
        WHEN the cuota is resolved for each
        THEN July uses the 2026-02 cuota and August the (higher) 2026-08 cuota (ADR-067)
        """
        # GIVEN
        reader = _reader({"current_category": "A", "activity_type": "services"})

        # WHEN — July 2026 (pre-boundary) vs August 2026 (on/after boundary).
        july = await reader._monotributo_cuota("u1", as_of=date(2026, 7, 1))
        august = await reader._monotributo_cuota("u1", as_of=date(2026, 8, 1))

        # THEN — the target-month vintage drives the figure; Aug's is the new, higher one.
        assert july is not None
        assert august is not None
        assert july == Decimal("42386.74")  # 2026-02 category A services cuota
        assert august == Decimal("49527.18")  # 2026-08 category A services cuota
        assert august > july

    async def test_no_config_yields_none(self):
        """
        GIVEN no configured category
        WHEN the cuota is resolved
        THEN None is returned (the tax leg is omitted)
        """
        # WHEN / THEN
        assert await _reader({})._monotributo_cuota("u1", as_of=date(2026, 7, 1)) is None

    async def test_unknown_category_yields_none(self):
        """
        GIVEN a configured category that is not in the scale table
        WHEN the cuota is resolved
        THEN None is returned rather than raising (ADR-177)
        """
        # GIVEN — a bogus category token the scale does not know.
        reader = _reader({"current_category": "ZZ", "activity_type": "services"})

        # WHEN / THEN
        assert await reader._monotributo_cuota("u1", as_of=date(2026, 7, 1)) is None


def _candidate(
    *,
    source: CommitmentSource = CommitmentSource.INSTALLMENT,
    name: str = "Stream",
    category: str | None = "Shopping",
    exact_posted: Decimal | None = None,
    expected: Decimal | None = None,
) -> _StreamCandidate:
    """Build a stream candidate for the loose-fallback assembly tests (ADR-199)."""
    return _StreamCandidate(source=source, name=name, category=category, exact_posted=exact_posted, expected=expected)


class TestLooseFallbackTolerance:
    """The loose fallback matches a same-category charge within ±15% of expected (ADR-199)."""

    def test_matches_same_category_within_tolerance(self):
        """
        GIVEN a pending stream (expected 68,750) and a same-category charge within 15%
        WHEN the split is resolved
        THEN the stream is paid at the charge's amount (75,000 is within tolerance ~10,312)
        """
        # GIVEN
        candidates = [_candidate(expected=Decimal("68750"))]
        pool = [_PoolCharge(name="TOMMY HILFIGER UNICENTER", category="Shopping", amount=Decimal("75000"))]

        # WHEN
        (stream,) = _reader()._resolve_paid(candidates, pool)

        # THEN
        assert stream.posted == Decimal("75000")

    def test_no_expected_stays_pending(self):
        """
        GIVEN a stream not due this month (no expected amount)
        WHEN the split is resolved
        THEN nothing matches — the stream is not a loose-fallback candidate
        """
        # GIVEN
        pool = [_PoolCharge(name="X", category="Shopping", amount=Decimal("100"))]

        # WHEN
        (stream,) = _reader()._resolve_paid([_candidate(expected=None)], pool)

        # THEN
        assert stream.posted is None

    def test_out_of_tolerance_does_not_match(self):
        """
        GIVEN a same-category charge whose amount is well outside ±15% of expected
        WHEN the split is resolved
        THEN it does not match (the stream stays pending)
        """
        # GIVEN — 50,000 is far below 15% of 68,750.
        pool = [_PoolCharge(name="Other", category="Shopping", amount=Decimal("50000"))]

        # WHEN
        (stream,) = _reader()._resolve_paid([_candidate(expected=Decimal("68750"))], pool)

        # THEN
        assert stream.posted is None

    def test_different_category_does_not_match(self):
        """
        GIVEN an in-tolerance charge in a DIFFERENT category
        WHEN the split is resolved
        THEN it does not match (matching is category-scoped)
        """
        # GIVEN
        pool = [_PoolCharge(name="Food thing", category="Food", amount=Decimal("70000"))]

        # WHEN
        (stream,) = _reader()._resolve_paid([_candidate(category="Shopping", expected=Decimal("68750"))], pool)

        # THEN
        assert stream.posted is None

    def test_zero_expected_stays_pending(self):
        """
        GIVEN a stream whose expected amount is zero (nothing meaningful to fulfil)
        WHEN the split is resolved
        THEN nothing matches
        """
        # WHEN
        (stream,) = _reader()._resolve_paid([_candidate(expected=Decimal("0"))], [])

        # THEN
        assert stream.posted is None


class TestResolvePaid:
    """``_resolve_paid`` applies the exact-first, closest-fit loose fallback across streams (ADR-199)."""

    def test_exact_posted_wins_and_its_charge_is_removed_from_pool(self):
        """
        GIVEN one stream that already posted EXACTLY and a second pending stream sharing its
              category whose expected is within tolerance of the exact stream's charge
        WHEN the split is resolved
        THEN the exact stream keeps its posted figure, its charge is NOT reused, and the
             second stream stays pending (no double-count, ADR-179/199)
        """
        # GIVEN — "Netflix" posted exactly (100, Shopping); a pending "Plan" expects ~100.
        candidates = [
            _candidate(name="Netflix", category="Shopping", exact_posted=Decimal("100"), expected=None),
            _candidate(name="Plan", category="Shopping", exact_posted=None, expected=Decimal("100")),
        ]
        pool = [_PoolCharge(name="Netflix", category="Shopping", amount=Decimal("100"))]

        # WHEN
        streams = _reader()._resolve_paid(candidates, pool)

        # THEN — Netflix paid at 100; the Plan finds no charge left → pending.
        by_name = dict(zip((c.name for c in candidates), streams, strict=True))
        assert by_name["Netflix"].posted == Decimal("100")
        assert by_name["Plan"].posted is None
        assert by_name["Plan"].expected == Decimal("100")

    def test_loose_fallback_marks_untagged_charge_as_paid(self):
        """
        GIVEN a pending installment stream and a differently-named, same-category untagged
              charge within tolerance
        WHEN the split is resolved
        THEN the stream is PAID at the matched charge's amount (ADR-199 loose fallback)
        """
        # GIVEN — a "TOMMY" plan expects 68,750; a renamed charge in Shopping is 70,000.
        candidates = [_candidate(name="TOMMY", category="Shopping", exact_posted=None, expected=Decimal("68750"))]
        pool = [_PoolCharge(name="TOMMY HILFIGER UNICENTER", category="Shopping", amount=Decimal("70000"))]

        # WHEN
        (stream,) = _reader()._resolve_paid(candidates, pool)

        # THEN
        assert stream.posted == Decimal("70000")

    def test_greedy_gives_each_stream_a_distinct_charge(self):
        """
        GIVEN two same-category pending streams and two in-tolerance charges
        WHEN the split is resolved
        THEN each stream claims its OWN nearest charge, and neither charge fulfils two
             streams (ADR-199)
        """
        # GIVEN — two Shopping streams (100k, 50k) and two Shopping charges near them.
        candidates = [
            _candidate(name="Small", category="Shopping", expected=Decimal("50000")),
            _candidate(name="Big", category="Shopping", expected=Decimal("100000")),
        ]
        pool = [
            _PoolCharge(name="Charge A", category="Shopping", amount=Decimal("52000")),
            _PoolCharge(name="Charge B", category="Shopping", amount=Decimal("98000")),
        ]

        # WHEN
        streams = _reader()._resolve_paid(candidates, pool)

        # THEN — Big claims the 98,000 charge (its nearest), Small claims the 52,000 one.
        by_name = dict(zip((c.name for c in candidates), streams, strict=True))
        assert by_name["Big"].posted == Decimal("98000")
        assert by_name["Small"].posted == Decimal("52000")

    def test_single_charge_does_not_satisfy_two_streams(self):
        """
        GIVEN two same-category pending streams but only ONE in-tolerance charge
        WHEN the split is resolved
        THEN exactly one stream is paid and the other stays pending (one-charge-per-stream)
        """
        # GIVEN — two Shopping streams both expecting ~100,000; one 100,000 charge.
        candidates = [
            _candidate(name="First", category="Shopping", expected=Decimal("100000")),
            _candidate(name="Second", category="Shopping", expected=Decimal("100000")),
        ]
        pool = [_PoolCharge(name="Only", category="Shopping", amount=Decimal("100000"))]

        # WHEN
        streams = _reader()._resolve_paid(candidates, pool)

        # THEN — exactly one paid, one pending.
        posted = [s.posted for s in streams]
        assert posted.count(Decimal("100000")) == 1
        assert posted.count(None) == 1

    def test_closest_fit_wins_when_order_and_nearest_diverge(self):
        """
        GIVEN two same-category streams (expected 68,750 & 61,000) and charges laid out so
              the FIRST-in-order charge is NOT the nearest for the first stream
        WHEN the split is resolved
        THEN each stream is matched to its OWN nearest charge, not the first in tolerance —
             closest-fit beats naive largest-first + first-in-tolerance (ADR-199)
        """
        # GIVEN — pool order [61,066, 68,750]; naive first-in-tolerance would let 68,750
        # grab 61,066 (within its ±15%), stealing 61,000's exact charge. Closest-fit must
        # instead give 68,750 → 68,750 (gap 0) and 61,000 → 61,066 (gap 66).
        candidates = [
            _candidate(name="TOMMY", category="Shopping", expected=Decimal("68750")),
            _candidate(name="Cuota", category="Shopping", expected=Decimal("61000")),
        ]
        pool = [
            _PoolCharge(name="Charge Near 61k", category="Shopping", amount=Decimal("61066")),
            _PoolCharge(name="Charge Near 68k", category="Shopping", amount=Decimal("68750")),
        ]

        # WHEN
        streams = _reader()._resolve_paid(candidates, pool)

        # THEN
        by_name = dict(zip((c.name for c in candidates), streams, strict=True))
        assert by_name["TOMMY"].posted == Decimal("68750")
        assert by_name["Cuota"].posted == Decimal("61066")

    def test_cross_source_split_is_not_inverted(self):
        """
        GIVEN a SUBSCRIPTION due at 100,000 with NO matching charge, and an INSTALLMENT due
              at 95,000 with a same-category 95,000 charge
        WHEN the split is resolved
        THEN the installment is PAID at 95,000 and the subscription stays PENDING — the
             larger subscription must not steal the installment's exact-fit charge (ADR-199)
        """
        # GIVEN — same category "Insurance"; the 95,000 charge fits Cuota Auto exactly (gap 0)
        # and Seguro loosely (gap 5,000, within its ±15%). Closest-fit keeps it with Cuota Auto.
        candidates = [
            _candidate(
                source=CommitmentSource.SUBSCRIPTION, name="Seguro", category="Insurance", expected=Decimal("100000")
            ),
            _candidate(
                source=CommitmentSource.INSTALLMENT, name="Cuota Auto", category="Insurance", expected=Decimal("95000")
            ),
        ]
        pool = [_PoolCharge(name="AUTO INSURANCE CO", category="Insurance", amount=Decimal("95000"))]

        # WHEN
        streams = _reader()._resolve_paid(candidates, pool)

        # THEN — installment paid, subscription still pending; buckets not inverted.
        by_name = dict(zip((c.name for c in candidates), streams, strict=True))
        assert by_name["Cuota Auto"].source is CommitmentSource.INSTALLMENT
        assert by_name["Cuota Auto"].posted == Decimal("95000")
        assert by_name["Seguro"].source is CommitmentSource.SUBSCRIPTION
        assert by_name["Seguro"].posted is None
        assert by_name["Seguro"].expected == Decimal("100000")
