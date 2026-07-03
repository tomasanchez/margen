"""Unit tests for the pure committed-spend split assembly (ADR-179).

These drive the I/O-free engine with plain stream inputs (ADR-032): the paid side
(committed rows already posted this month), the pending side (expected-this-month
committed outflows not yet posted, evaluated at offset 0), the CRITICAL flip (a stream
posted this month is paid and NOT also pending — no double-count, ADR-176), the mixed
subscription + installment + tax breakdown, the ARS + USD denomination + unconverted
count, the ARS-fixed monotributo cuota (summed only on an ARS request), and an empty
split. Denomination itself lives in the adapter; here the stream amounts are treated
as already denominated.
"""

from __future__ import annotations

from decimal import Decimal

from margen_api.service_layer.committed import CURRENCY_ARS, CommittedStream, build_committed
from margen_api.service_layer.forecast_read_models import CommitmentSource

_MONTH = "2026-06"


def _subscription(*, posted: Decimal | None = None, expected: Decimal | None = None) -> CommittedStream:
    """Build a subscription stream with the given posted/expected figures."""
    return CommittedStream(source=CommitmentSource.SUBSCRIPTION, posted=posted, expected=expected)


def _installment(*, posted: Decimal | None = None, expected: Decimal | None = None) -> CommittedStream:
    """Build an instalment stream with the given posted/expected figures."""
    return CommittedStream(source=CommitmentSource.INSTALLMENT, posted=posted, expected=expected)


def _tax(*, posted: Decimal | None = None, expected: Decimal | None = None) -> CommittedStream:
    """Build the AFIP-ARS monotributo tax stream with the given posted/expected figures."""
    return CommittedStream(source=CommitmentSource.TAX, posted=posted, expected=expected, ars_fixed=True)


class TestPaidOnly:
    """A month whose committed streams have all posted is fully paid, nothing pending (ADR-179)."""

    def test_posted_streams_are_paid_and_broken_out_by_source(self):
        """
        GIVEN a subscription and an instalment cuota both already posted this month
        WHEN the split is built
        THEN both land on the paid side per source and pending is empty
        """
        # GIVEN
        streams = [_subscription(posted=Decimal("100")), _installment(posted=Decimal("500"))]

        # WHEN
        split = build_committed(_MONTH, "ARS", streams=streams, unconverted=0)

        # THEN
        assert split.month == _MONTH
        assert split.currency == "ARS"
        assert split.paid.subscription == Decimal("100.00")
        assert split.paid.installment == Decimal("500.00")
        assert split.paid.tax == Decimal("0.00")
        assert split.paid.total == Decimal("600.00")
        assert split.pending.total == Decimal("0.00")


class TestPendingOnly:
    """An obligation due this month but not yet posted is pending, not paid (ADR-179)."""

    def test_expected_unposted_stream_is_pending(self):
        """
        GIVEN a subscription expected this month whose latest actual is a prior month
        WHEN the split is built
        THEN its amount is pending and the paid side is empty
        """
        # GIVEN — expected set, posted None (not yet landed this month).
        streams = [_subscription(expected=Decimal("100"))]

        # WHEN
        split = build_committed(_MONTH, "ARS", streams=streams, unconverted=0)

        # THEN
        assert split.pending.subscription == Decimal("100.00")
        assert split.pending.total == Decimal("100.00")
        assert split.paid.total == Decimal("0.00")


class TestFlip:
    """A stream posted this month is paid and NOT also pending - the no-double-count case (ADR-176/179)."""

    def test_posted_stream_never_double_counts_as_pending(self):
        """
        GIVEN a stream that is BOTH expected this month AND already posted this month
        WHEN the split is built
        THEN it counts only as paid - it flips out of pending (no double-count)
        """
        # GIVEN — a cuota that landed this month; the adapter still supplied its expected.
        streams = [_installment(posted=Decimal("500"), expected=Decimal("500"))]

        # WHEN
        split = build_committed(_MONTH, "ARS", streams=streams, unconverted=0)

        # THEN — paid holds it once; pending is empty.
        assert split.paid.installment == Decimal("500.00")
        assert split.pending.installment == Decimal("0.00")
        assert split.pending.total == Decimal("0.00")


class TestMixedSources:
    """Paid + pending are broken out across subscriptions, instalments and the tax (ADR-179)."""

    def test_subscription_installment_and_monotributo_mixed(self):
        """
        GIVEN a posted subscription, a pending instalment and a pending monotributo cuota (ARS)
        WHEN the split is built for an ARS request
        THEN paid holds the subscription and pending holds the instalment + the tax cuota
        """
        # GIVEN
        streams = [
            _subscription(posted=Decimal("100")),
            _installment(expected=Decimal("500")),
            _tax(expected=Decimal("42386.74")),
        ]

        # WHEN
        split = build_committed(_MONTH, "ARS", streams=streams, unconverted=0)

        # THEN
        assert split.paid.subscription == Decimal("100.00")
        assert split.paid.total == Decimal("100.00")
        assert split.pending.installment == Decimal("500.00")
        assert split.pending.tax == Decimal("42386.74")
        assert split.pending.total == Decimal("42886.74")


class TestMonotributoDenomination:
    """The AFIP-ARS cuota is summed into a total only on an ARS request (ADR-177)."""

    def test_ars_request_sums_the_cuota(self):
        """
        GIVEN a pending monotributo cuota on an ARS request
        WHEN the split is built
        THEN the cuota joins the pending tax total (same ARS denomination)
        """
        # WHEN
        split = build_committed(_MONTH, CURRENCY_ARS, streams=[_tax(expected=Decimal("50000"))], unconverted=0)

        # THEN
        assert split.pending.tax == Decimal("50000.00")
        assert split.pending.total == Decimal("50000.00")

    def test_usd_request_excludes_the_cuota_from_totals(self):
        """
        GIVEN a monotributo cuota alongside a USD subscription on a USD request
        WHEN the split is built
        THEN the USD totals hold only the subscription; the ARS cuota is never re-denominated
        """
        # GIVEN
        streams = [_subscription(posted=Decimal("5")), _tax(expected=Decimal("50000"))]

        # WHEN
        split = build_committed(_MONTH, "USD", streams=streams, unconverted=0)

        # THEN — the cuota is dropped from the USD totals (never re-denominated, ADR-177).
        assert split.paid.subscription == Decimal("5.00")
        assert split.pending.tax == Decimal("0.00")
        assert split.paid.tax == Decimal("0.00")


class TestUsdDenomination:
    """USD excludes snapshotless streams (amount None) and echoes the unconverted count (ADR-152)."""

    def test_none_amount_streams_contribute_nothing_and_unconverted_reported(self):
        """
        GIVEN a USD subscription whose snapshot was missing (posted None, expected None)
              and the adapter-supplied unconverted count
        WHEN the split is built
        THEN it contributes nothing to either side and the unconverted count is echoed
        """
        # GIVEN — a snapshotless stream carries None on both sides; the adapter counted it.
        streams = [_subscription(posted=None, expected=None), _subscription(posted=Decimal("5"))]

        # WHEN
        split = build_committed(_MONTH, "USD", streams=streams, unconverted=1)

        # THEN
        assert split.currency == "USD"
        assert split.unconverted == 1
        assert split.paid.subscription == Decimal("5.00")
        assert split.pending.total == Decimal("0.00")


class TestEmpty:
    """A user with no committed streams gets an empty split (ADR-179)."""

    def test_no_streams_is_all_zero(self):
        """
        GIVEN no committed streams
        WHEN the split is built
        THEN every paid/pending figure is 0.00 and unconverted is 0
        """
        # WHEN
        split = build_committed(_MONTH, "ARS", streams=[], unconverted=0)

        # THEN
        assert split.paid.total == Decimal("0.00")
        assert split.pending.total == Decimal("0.00")
        assert split.paid.subscription == Decimal("0.00")
        assert split.pending.installment == Decimal("0.00")
        assert split.unconverted == 0
