"""Unit tests for the pure schedule/commitment-driven forecast assembly (ADR-176, ADR-177).

These drive the I/O-free engine with plain stream inputs (ADR-032): the forward
horizon window (starts the month AFTER the current month, clamped 1..12), recurring
flat projection on each cadence, the instalment tail length (= total - index, starting
the month after the last actual), the monotributo cuota in every month, the committed
sums, the ARS + USD denomination + unconverted count, the CRITICAL no-double-count rule
(a stream with an actual in month M is NOT projected into M), an empty/no-commitments
forecast, and the horizon clamp. Denomination itself lives in the adapter; here the
stream amounts are treated as already denominated.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from margen_api.domain.models.value_objects import RecurringCadence
from margen_api.service_layer.forecast import (
    DEFAULT_HORIZON,
    MAX_HORIZON,
    MIN_HORIZON,
    MONOTRIBUTO_LABEL,
    InstallmentStream,
    RecurringStream,
    build_forecast,
    clamp_horizon,
    horizon_window,
)
from margen_api.service_layer.forecast_read_models import CommitmentSource

_REF = date(2026, 6, 15)  # anchor: current month is 2026-06; horizon starts 2026-07.


class TestClampHorizon:
    """The horizon is clamped into the supported 1..12 window (ADR-176)."""

    @pytest.mark.parametrize(
        ("requested", "expected"),
        [(0, MIN_HORIZON), (1, 1), (6, 6), (12, MAX_HORIZON), (99, MAX_HORIZON), (-3, MIN_HORIZON)],
    )
    def test_clamps_to_bounds(self, requested: int, expected: int):
        """
        GIVEN a requested horizon inside or outside the 1..12 bounds
        WHEN it is clamped
        THEN it lands within [1, 12]
        """
        # WHEN / THEN
        assert clamp_horizon(requested) == expected


class TestHorizonWindow:
    """The horizon window starts the month AFTER the current month, oldest-first (ADR-176)."""

    def test_starts_next_month(self):
        """
        GIVEN a reference in June 2026 and a 3-month horizon
        WHEN the window is built
        THEN it is Jul, Aug, Sep 2026 — never the current or a past month
        """
        # WHEN
        window = horizon_window(_REF, 3)

        # THEN
        assert window == [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]

    def test_crosses_year_boundary(self):
        """
        GIVEN a reference in November 2026 and a 3-month horizon
        WHEN the window is built
        THEN it spans Dec 2026, Jan and Feb 2027
        """
        # WHEN
        window = horizon_window(date(2026, 11, 5), 3)

        # THEN
        assert window == [date(2026, 12, 1), date(2027, 1, 1), date(2027, 2, 1)]


def _forecast(**kwargs):
    """Build a forecast with sensible empty defaults, overridden by kwargs."""
    horizon = kwargs.pop("horizon", DEFAULT_HORIZON)
    currency = kwargs.pop("currency", "ARS")
    params = {
        "recurring_streams": [],
        "installment_streams": [],
        "monotributo_cuota": None,
        "unconverted": 0,
    }
    params.update(kwargs)
    return build_forecast(_REF, horizon, currency, **params)


class TestRecurringProjection:
    """A flagged recurring stream repeats its latest amount on its cadence (ADR-176)."""

    def test_monthly_repeats_every_future_month(self):
        """
        GIVEN a monthly subscription last seen in the current month (2026-06)
        WHEN a 3-month forecast is built
        THEN its amount lands in every one of Jul, Aug, Sep and the months sum it
        """
        # GIVEN
        stream = RecurringStream(
            label="Netflix",
            amount=Decimal("100"),
            cadence=RecurringCadence.MONTHLY,
            last_actual_month="2026-06",
        )

        # WHEN
        series = build_forecast(
            _REF, 3, "ARS", recurring_streams=[stream], installment_streams=[], monotributo_cuota=None, unconverted=0
        )

        # THEN
        assert [m.month for m in series.months] == ["2026-07", "2026-08", "2026-09"]
        assert [m.committed for m in series.months] == [Decimal("100.00")] * 3
        assert all(m.total == m.committed for m in series.months)
        assert all(m.confidence == "committed" for m in series.months)
        (line,) = series.commitments
        assert line.source is CommitmentSource.SUBSCRIPTION
        assert line.label == "Netflix"
        assert line.months == ["2026-07", "2026-08", "2026-09"]
        assert line.remaining_count is None

    def test_quarterly_lands_every_third_month(self):
        """
        GIVEN a quarterly stream last seen in 2026-06
        WHEN a 6-month forecast is built
        THEN it lands only in the months whose offset is a multiple of 3 (Sep, Dec)
        """
        # GIVEN
        stream = RecurringStream(
            label="Insurance",
            amount=Decimal("300"),
            cadence=RecurringCadence.QUARTERLY,
            last_actual_month="2026-06",
        )

        # WHEN
        series = _forecast(recurring_streams=[stream])

        # THEN — offsets 3 (Sep) and 6 (Dec) from 2026-06 within the 6-month horizon.
        hit_months = [m.month for m in series.months if m.committed > Decimal(0)]
        assert hit_months == ["2026-09", "2026-12"]
        assert series.commitments[0].months == ["2026-09", "2026-12"]

    def test_annual_lands_once_at_the_year_offset(self):
        """
        GIVEN an annual stream last seen in the current month (2026-06)
        WHEN a 12-month forecast is built (Jul 2026..Jun 2027)
        THEN it lands once, 12 months after the last actual (2027-06), the last month
        """
        # GIVEN
        stream = RecurringStream(
            label="Domain",
            amount=Decimal("50"),
            cadence=RecurringCadence.ANNUAL,
            last_actual_month="2026-06",
        )

        # WHEN
        series = _forecast(recurring_streams=[stream], horizon=12)

        # THEN
        hit_months = [m.month for m in series.months if m.committed > Decimal(0)]
        assert hit_months == ["2027-06"]


class TestNoDoubleCount:
    """A stream is NEVER projected into a month at/before its latest actual (ADR-176)."""

    def test_actual_in_current_month_projects_into_future_only(self):
        """
        GIVEN a monthly stream whose latest actual is the CURRENT month (2026-06)
        WHEN the forecast is built
        THEN nothing is projected into 2026-06 (a past/current month) and the future
             months all carry it — actuals own the past, projection owns the future
        """
        # GIVEN
        stream = RecurringStream(
            label="Rent", amount=Decimal("200"), cadence=RecurringCadence.MONTHLY, last_actual_month="2026-06"
        )

        # WHEN
        series = _forecast(recurring_streams=[stream], horizon=2)

        # THEN — the window is 2026-07, 2026-08 only; 2026-06 is never in the series.
        assert "2026-06" not in [m.month for m in series.months]
        assert all(m.committed == Decimal("200.00") for m in series.months)

    def test_future_actual_suppresses_earlier_projection(self):
        """
        GIVEN a monthly stream whose latest actual is AHEAD of the current month (2026-08)
        WHEN a 4-month forecast is built (Jul..Oct)
        THEN Jul and Aug carry nothing (they are at/before the last actual) and only
             Sep and Oct — strictly after it — are projected
        """
        # GIVEN
        stream = RecurringStream(
            label="Gym", amount=Decimal("80"), cadence=RecurringCadence.MONTHLY, last_actual_month="2026-08"
        )

        # WHEN
        series = _forecast(recurring_streams=[stream], horizon=4)

        # THEN
        by_month = {m.month: m.committed for m in series.months}
        assert by_month["2026-07"] == Decimal("0.00")
        assert by_month["2026-08"] == Decimal("0.00")
        assert by_month["2026-09"] == Decimal("80.00")
        assert by_month["2026-10"] == Decimal("80.00")


class TestInstallmentTail:
    """An instalment tail projects its remaining cuotas monthly after the last actual (ADR-176)."""

    def test_tail_length_and_start(self):
        """
        GIVEN an instalment plan with 4 remaining payments last seen in 2026-06
        WHEN a 6-month forecast is built
        THEN the cuota lands in the next 4 months (Jul..Oct) and stops, and the line
             reports the remaining count
        """
        # GIVEN
        stream = InstallmentStream(
            label="Fridge 6 cuotas", amount=Decimal("500"), remaining_count=4, last_actual_month="2026-06"
        )

        # WHEN
        series = _forecast(installment_streams=[stream])

        # THEN — remaining=4 → Jul, Aug, Sep, Oct; Nov, Dec are past the tail.
        hits = [m.month for m in series.months if m.committed > Decimal(0)]
        assert hits == ["2026-07", "2026-08", "2026-09", "2026-10"]
        (line,) = series.commitments
        assert line.source is CommitmentSource.INSTALLMENT
        assert line.remaining_count == 4
        assert line.months == hits

    def test_paid_off_plan_projects_nothing(self):
        """
        GIVEN an instalment plan with 0 remaining payments (already the last cuota)
        WHEN the forecast is built
        THEN it lands nothing and produces no commitment line
        """
        # GIVEN
        stream = InstallmentStream(
            label="Paid off", amount=Decimal("500"), remaining_count=0, last_actual_month="2026-06"
        )

        # WHEN
        series = _forecast(installment_streams=[stream])

        # THEN
        assert all(m.committed == Decimal("0.00") for m in series.months)
        assert series.commitments == []

    def test_tail_starts_after_a_future_last_actual(self):
        """
        GIVEN an instalment plan whose last actual is ahead of the current month (2026-08)
        WHEN a 4-month forecast is built (Jul..Oct)
        THEN nothing lands in Jul/Aug and the tail begins in Sep — no double-count
        """
        # GIVEN
        stream = InstallmentStream(
            label="Laptop", amount=Decimal("1000"), remaining_count=2, last_actual_month="2026-08"
        )

        # WHEN
        series = _forecast(installment_streams=[stream], horizon=4)

        # THEN
        hits = [m.month for m in series.months if m.committed > Decimal(0)]
        assert hits == ["2026-09", "2026-10"]


class TestMonotributo:
    """The monotributo cuota is a committed tax outflow in every horizon month (ADR-177)."""

    def test_cuota_in_every_month(self):
        """
        GIVEN a configured monotributo cuota
        WHEN a 3-month forecast is built
        THEN the cuota is added to every month and a single tax commitment line spans
             the whole horizon
        """
        # WHEN
        series = _forecast(monotributo_cuota=Decimal("42386.74"), horizon=3)

        # THEN
        assert [m.committed for m in series.months] == [Decimal("42386.74")] * 3
        (line,) = series.commitments
        assert line.source is CommitmentSource.TAX
        assert line.label == MONOTRIBUTO_LABEL
        assert line.months == ["2026-07", "2026-08", "2026-09"]
        assert line.remaining_count is None

    def test_zero_or_none_cuota_is_omitted(self):
        """
        GIVEN a monotributo cuota of zero (or None)
        WHEN the forecast is built
        THEN no tax commitment line is produced
        """
        # WHEN
        zero = _forecast(monotributo_cuota=Decimal("0"))
        absent = _forecast(monotributo_cuota=None)

        # THEN
        assert zero.commitments == []
        assert absent.commitments == []


class TestCombinedSums:
    """Committed sums add subscriptions + instalments + tax per month (ADR-176)."""

    def test_month_totals_sum_all_committed_sources(self):
        """
        GIVEN a monthly subscription, an instalment tail and a monotributo cuota
        WHEN a 2-month forecast is built
        THEN each month sums all three committed sources and there are three commitments
        """
        # GIVEN
        sub = RecurringStream(
            label="Spotify", amount=Decimal("10"), cadence=RecurringCadence.MONTHLY, last_actual_month="2026-06"
        )
        plan = InstallmentStream(label="Sofa", amount=Decimal("100"), remaining_count=2, last_actual_month="2026-06")

        # WHEN
        series = build_forecast(
            _REF,
            2,
            "ARS",
            recurring_streams=[sub],
            installment_streams=[plan],
            monotributo_cuota=Decimal("50"),
            unconverted=0,
        )

        # THEN — each month: 10 + 100 + 50 = 160.
        assert [m.committed for m in series.months] == [Decimal("160.00"), Decimal("160.00")]
        assert len(series.commitments) == 3


class TestDenomination:
    """USD excludes streams lacking a snapshot and surfaces the unconverted count (ADR-152, ADR-168)."""

    def test_ars_echoes_currency_and_zero_unconverted(self):
        """
        GIVEN an ARS forecast
        WHEN it is built
        THEN the currency echoes ARS and every commitment carries the ARS currency
        """
        # GIVEN
        stream = RecurringStream(
            label="X", amount=Decimal("10"), cadence=RecurringCadence.MONTHLY, last_actual_month="2026-06"
        )

        # WHEN
        series = _forecast(recurring_streams=[stream], currency="ARS")

        # THEN
        assert series.currency == "ARS"
        assert series.commitments[0].currency == "ARS"

    def test_usd_none_amount_stream_is_skipped_but_unconverted_reported(self):
        """
        GIVEN a USD forecast with a subscription whose snapshot was missing (amount None)
              and the adapter-supplied unconverted count
        WHEN it is built
        THEN the stream contributes nothing to the sums and produces no commitment line,
             while the unconverted count is echoed to the caller
        """
        # GIVEN
        missing = RecurringStream(
            label="NoSnapshot", amount=None, cadence=RecurringCadence.MONTHLY, last_actual_month="2026-06"
        )
        present = RecurringStream(
            label="Ok", amount=Decimal("5"), cadence=RecurringCadence.MONTHLY, last_actual_month="2026-06"
        )

        # WHEN
        series = build_forecast(
            _REF,
            2,
            "USD",
            recurring_streams=[missing, present],
            installment_streams=[],
            monotributo_cuota=None,
            unconverted=1,
        )

        # THEN
        assert series.currency == "USD"
        assert series.unconverted == 1
        assert [line.label for line in series.commitments] == ["Ok"]
        assert all(m.committed == Decimal("5.00") for m in series.months)


class TestEmptyForecast:
    """A user with no committed streams gets a flat, empty forecast (ADR-176)."""

    def test_no_commitments_zero_months(self):
        """
        GIVEN no recurring, instalment or tax commitments
        WHEN a 6-month forecast is built
        THEN every month is 0.00, there are no commitments and the horizon is echoed
        """
        # WHEN
        series = _forecast()

        # THEN
        assert series.horizon == DEFAULT_HORIZON
        assert len(series.months) == DEFAULT_HORIZON
        assert all(m.committed == Decimal("0.00") and m.total == Decimal("0.00") for m in series.months)
        assert series.commitments == []
        assert series.unconverted == 0
