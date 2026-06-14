"""Unit tests for the pure Monotributo standing logic (ADR-046, ADR-052, ADR-050).

These exercise the status bands, the linear-annualization projection, the
margin / percent math and the trailing-window arithmetic with plain objects,
Decimals and dates -- no database, no HTTP (ADR-032). They are the fast tier that
proves the financial computation is correct independently of SQL.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.domain.models.monotributo_scale import current_scale, get_ceiling
from margen_api.service_layer.monotributo import (
    DEFAULT_ACTIVITY_TYPE,
    DEFAULT_CATEGORY,
    _percent_used,
    build_snapshot,
    build_standing,
    month_start,
    prior_window,
    project,
    scale_entries,
    status_band,
    status_copy,
    trailing_window,
)
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoStanding,
)

TODAY = date(2026, 6, 14)
CEILING_A = get_ceiling("A")


class TestStatusBand:
    """``status_band`` maps a percent-of-ceiling figure to a band (ADR-046)."""

    @pytest.mark.parametrize(
        ("percent", "expected"),
        [
            (Decimal("0"), "safe"),
            (Decimal("69"), "safe"),
            (Decimal("69.99"), "safe"),
            (Decimal("70"), "watch"),
            (Decimal("89"), "watch"),
            (Decimal("89.99"), "watch"),
            (Decimal("90"), "close"),
            (Decimal("99"), "close"),
            (Decimal("100"), "close"),
            (Decimal("100.01"), "over"),
            (Decimal("101"), "over"),
            (Decimal("250"), "over"),
        ],
    )
    def test_band_boundaries(self, percent: Decimal, expected: str) -> None:
        """
        GIVEN a percent-of-ceiling figure on or around a band boundary
        WHEN the status band is computed
        THEN it lands in the documented band (safe <70, watch 70-90, close 90-100, over >100)
        """
        assert status_band(percent) == expected


class TestStatusCopy:
    """``status_copy`` returns the calm display string per band (ADR-046)."""

    @pytest.mark.parametrize(
        ("band", "expected"),
        [
            ("safe", "On track"),
            ("watch", "Keep an eye on this"),
            ("close", "Close to your limit"),
            ("over", "Over your limit"),
        ],
    )
    def test_copy_per_band(self, band: str, expected: str) -> None:
        """GIVEN a band key WHEN the copy is looked up THEN it is the calm string."""
        assert status_copy(band) == expected


class TestProject:
    """``project`` linearly annualizes ``used`` into a category and note (ADR-046)."""

    def test_annualizes_over_elapsed_fraction(self) -> None:
        """
        GIVEN income earned over roughly half the trailing window
        WHEN the projection runs
        THEN it annualizes used / fraction and picks the smallest covering category
        """
        # GIVEN — window started ~182 days before today => fraction ~0.5.
        window_start = date(2025, 12, 14)
        used = Decimal("4000000.00")

        # WHEN
        category, note = project(used, window_start=window_start, reference=TODAY)

        # THEN — annualized ~= 4M / (182/365) ~= 8.02M, which fits category A.
        assert category == "A"
        assert "estimate" in note.lower()

    def test_steady_pace_note_when_enough_data(self) -> None:
        """
        GIVEN plenty of elapsed window and non-zero income
        WHEN the projection runs
        THEN the note is the steady-pace estimate string, not the low-data caveat
        """
        # GIVEN — a full year elapsed (fraction clamps to 1).
        window_start = date(2025, 6, 14)
        used = Decimal("10000000.00")

        # WHEN
        _, note = project(used, window_start=window_start, reference=TODAY)

        # THEN
        assert note == "Estimate assuming you keep up your current pace."

    def test_low_confidence_note_when_little_elapsed(self) -> None:
        """
        GIVEN only a few days of the window elapsed (below the low-confidence cut)
        WHEN the projection runs
        THEN the note warns the estimate may change a lot
        """
        # GIVEN — window started 10 days ago => fraction ~0.027 < 0.25.
        window_start = date(2026, 6, 4)
        used = Decimal("100000.00")

        # WHEN
        _, note = project(used, window_start=window_start, reference=TODAY)

        # THEN
        assert "isn't much data" in note

    def test_low_confidence_note_when_no_income_yet(self) -> None:
        """
        GIVEN a full window elapsed but no income recorded
        WHEN the projection runs
        THEN the low-data caveat is used (zero used is treated as low-confidence)
        """
        # GIVEN — a full year elapsed but nothing earned.
        window_start = date(2025, 6, 14)

        # WHEN
        category, note = project(Decimal("0"), window_start=window_start, reference=TODAY)

        # THEN — annualized 0 still resolves to the smallest band.
        assert category == "A"
        assert "isn't much data" in note

    def test_future_reference_clamps_to_low_confidence_fraction(self) -> None:
        """
        GIVEN a reference at or before the window start (degenerate / future date)
        WHEN the projection runs
        THEN the elapsed fraction is clamped so the estimate cannot invert or blow up
        """
        # GIVEN — reference equals window start => zero elapsed days.
        window_start = TODAY

        # WHEN — used / 0.25 = 4x; still resolves to a valid category, no ZeroDivision.
        category, note = project(Decimal("1000000.00"), window_start=window_start, reference=TODAY)

        # THEN — the fraction floor (0.25) equals the low-confidence threshold, so a
        # degenerate window lands exactly on the boundary: a valid category, no blow-up.
        assert category in {row.letter for row in current_scale().categories}
        assert note


class TestBuildStanding:
    """``build_standing`` assembles ceiling / margin / percent / band (ADR-046)."""

    def test_margin_and_percent_math(self) -> None:
        """
        GIVEN a used total below the category A ceiling
        WHEN the standing is built
        THEN limit is the A ceiling, remaining is ceiling - used and percent is used/ceiling*100
        """
        # GIVEN
        used = Decimal("4496298.935")  # exactly half of the A ceiling
        window_start, window_end = trailing_window(TODAY)

        # WHEN
        standing = build_standing(
            used=used,
            category="A",
            activity_type="services",
            window_start=window_start,
            window_end=window_end,
            reference=TODAY,
        )

        # THEN
        assert standing.limit == CEILING_A
        assert standing.used == used
        assert standing.remaining == CEILING_A - used
        assert standing.percent_used == used / CEILING_A * Decimal(100)
        assert standing.category == "A"
        assert standing.activity_type == "services"
        assert standing.period_start == window_start
        assert standing.period_end == window_end

    def test_uses_the_correct_category_ceiling(self) -> None:
        """
        GIVEN a different configured category
        WHEN the standing is built
        THEN it reads that category's ceiling from the scale
        """
        # WHEN
        window_start, window_end = trailing_window(TODAY)
        standing = build_standing(
            used=Decimal("1000000"),
            category="H",
            activity_type="services",
            window_start=window_start,
            window_end=window_end,
            reference=TODAY,
        )

        # THEN
        assert standing.limit == get_ceiling("H")

    def test_over_limit_gives_negative_remaining_and_over_band(self) -> None:
        """
        GIVEN a used total above the ceiling
        WHEN the standing is built
        THEN remaining is negative and the status band is 'over'
        """
        # WHEN
        window_start, window_end = trailing_window(TODAY)
        standing = build_standing(
            used=CEILING_A + Decimal("1000000"),
            category="A",
            activity_type="services",
            window_start=window_start,
            window_end=window_end,
            reference=TODAY,
        )

        # THEN
        assert standing.remaining < Decimal("0")
        assert standing.status == "over"
        assert standing.percent_used > Decimal("100")

    def test_zero_ceiling_guard_avoids_division_by_zero(self) -> None:
        """
        GIVEN an artificial category whose ceiling is zero is not in the scale, but
              the percent guard must still hold for a zero-limit case
        WHEN percent is computed via build_standing with used 0 and a real ceiling
        THEN percent is a valid Decimal (the guard returns 0 only when ceiling is 0)
        """
        # WHEN — used 0 against a real ceiling => percent 0, no division surprise.
        window_start, window_end = trailing_window(TODAY)
        standing = build_standing(
            used=Decimal("0"),
            category="A",
            activity_type="services",
            window_start=window_start,
            window_end=window_end,
            reference=TODAY,
        )

        # THEN
        assert standing.percent_used == Decimal("0")
        assert standing.status == "safe"


class TestWindows:
    """Trailing / prior windows and ``month_start`` derive the right spans."""

    def test_trailing_window_ends_today_and_starts_12_months_back(self) -> None:
        """
        GIVEN a reference of mid-June 2026
        WHEN the trailing window is computed
        THEN it ends at the reference and starts at the first of the month 12 months earlier
        """
        # WHEN
        start, end = trailing_window(date(2026, 6, 14))

        # THEN
        assert end == date(2026, 6, 14)
        assert start == date(2025, 6, 1)

    def test_trailing_window_crosses_year_boundary(self) -> None:
        """
        GIVEN an early-year reference
        WHEN the trailing window is computed
        THEN the start rolls back into the prior year
        """
        # WHEN
        start, end = trailing_window(date(2026, 2, 10))

        # THEN
        assert start == date(2025, 2, 1)
        assert end == date(2026, 2, 10)

    def test_prior_window_ends_12_months_before_reference(self) -> None:
        """
        GIVEN a reference of mid-June 2026
        WHEN the prior window is computed
        THEN it ends at the first of the month 12 months ago and spans the 12 months before that
        """
        # WHEN
        start, end = prior_window(date(2026, 6, 14))

        # THEN — prior_end is month_start(June 2025) = 2025-06-01.
        assert end == date(2025, 6, 1)
        assert start == date(2024, 6, 1)

    def test_month_start_returns_first_of_month(self) -> None:
        """GIVEN any date WHEN month_start runs THEN it returns the first of that month."""
        assert month_start(date(2026, 6, 14)) == date(2026, 6, 1)
        assert month_start(date(2026, 1, 31)) == date(2026, 1, 1)


class TestScaleEntries:
    """``scale_entries`` projects the A-K constant into read-model rows (ADR-048)."""

    def test_returns_all_eleven_rows_in_order(self) -> None:
        """GIVEN the scale WHEN projected THEN all A-K rows come through in order."""
        # WHEN
        entries = scale_entries()

        # THEN
        first = current_scale().categories[0]
        assert [entry.letter for entry in entries] == list("ABCDEFGHIJK")
        assert entries[0].annual_ceiling == first.annual_ceiling
        assert entries[0].cuota_servicios == first.cuota_servicios
        assert entries[0].cuota_bienes == first.cuota_bienes


class TestBuildSnapshot:
    """``build_snapshot`` assembles current / previous / scale / invoices (ADR-052)."""

    def _standing(self, *, used: str) -> MonotributoStanding:
        """Build a standing fixture for assembly tests."""
        window_start, window_end = trailing_window(TODAY)
        return build_standing(
            used=Decimal(used),
            category="A",
            activity_type="services",
            window_start=window_start,
            window_end=window_end,
            reference=TODAY,
        )

    def test_assembles_full_snapshot_with_previous(self) -> None:
        """
        GIVEN a current standing, a previous standing and an invoice drilldown
        WHEN the snapshot is assembled
        THEN it carries all four parts and attaches the A-K scale
        """
        # GIVEN
        current = self._standing(used="1000000")
        previous = self._standing(used="500000")
        invoices = [
            MonotributoInvoice(
                id=uuid4(),
                occurred_on=date(2026, 1, 1),
                name="Invoice 1",
                category="Consulting",
                amount=Decimal("1000000"),
                currency="ARS",
                cumulative=Decimal("1000000"),
                is_foreign_currency=False,
            )
        ]

        # WHEN
        snapshot = build_snapshot(current=current, previous=previous, invoices=invoices)

        # THEN
        assert snapshot.current is current
        assert snapshot.previous is previous
        assert snapshot.invoices == invoices
        assert [entry.letter for entry in snapshot.scale] == list("ABCDEFGHIJK")

    def test_previous_may_be_none(self) -> None:
        """
        GIVEN no prior-window data
        WHEN the snapshot is assembled with previous=None
        THEN the snapshot still assembles with previous as None
        """
        # WHEN
        snapshot = build_snapshot(current=self._standing(used="1000000"), previous=None, invoices=[])

        # THEN
        assert snapshot.previous is None
        assert snapshot.invoices == []


class TestDefaults:
    """The module exposes the MVP defaults (ADR-046, ADR-048)."""

    def test_default_category_and_activity(self) -> None:
        """GIVEN the module THEN the smallest band and services are the defaults."""
        assert DEFAULT_CATEGORY == "A"
        assert DEFAULT_ACTIVITY_TYPE == "services"


class TestPercentUsed:
    """``_percent_used`` guards a zero ceiling (defensive; scales never have one)."""

    def test_zero_ceiling_yields_zero(self) -> None:
        """GIVEN a zero ceiling WHEN computing percent used THEN it returns 0, not a divide error."""
        assert _percent_used(Decimal("1000"), Decimal("0")) == Decimal("0")

    def test_nonzero_ceiling_is_a_percentage(self) -> None:
        """GIVEN a positive ceiling THEN percent used is used / ceiling * 100."""
        assert _percent_used(Decimal("50"), Decimal("200")) == Decimal("25")
