"""Pure assembly of the committed-spend accent split (ADR-179).

The SQLAlchemy adapter runs the per-stream aggregations — for each committed stream
(recurring subscription, instalment plan, monotributo cuota) it derives, for the
TARGET month, the already-posted amount (the committed rows that landed this month)
and the expected-this-month amount (the stream's cadence/tail evaluated at offset 0),
both already denominated in the requested currency (ADR-168) — and hands the raw,
I/O-free figures to these pure functions (like :mod:`forecast`), which:

* sum the **paid** side: each stream's already-posted amount this month, broken out by
  source (subscription / installment / tax). Paid rows are already inside the month's
  Expenses total (ADR-179);
* sum the **pending** side per stream at OFFSET 0 with the forecast's no-double-count
  rule (ADR-176): a stream contributes its expected-this-month amount to pending ONLY
  while it has NOT yet posted this month. Once its row lands (``posted`` set), the
  stream flips to paid and drops out of pending — the pending figure is never
  re-added to the spent total (ADR-179);
* keep the monotributo cuota as an AFIP-ARS figure (ADR-177): it is summed into a
  paid/pending total only on an ARS request; on a USD request it is never
  re-denominated into the USD totals and never counted as ``unconverted``.

All money is denominated in the requested currency by the adapter (ADR-168). Money is
:class:`~decimal.Decimal` throughout (ADR-025). Keeping the split assembly here keeps
SQLAlchemy in the adapter (AGENTS.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from margen_api.service_layer.committed_read_models import CommittedBySource, CommittedSplit
from margen_api.service_layer.forecast_read_models import CommitmentSource

_ZERO = Decimal(0)
_CENTS = Decimal("0.01")

# The requested-currency token that shares the monotributo cuota's AFIP-ARS
# denomination — the only currency the cuota may be summed into a total (ADR-177).
CURRENCY_ARS = "ARS"


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class CommittedStream:
    """One committed stream's paid/pending inputs for the target month (ADR-179).

    The adapter derives one of these per committed stream (a recurring subscription, an
    instalment plan, or the monotributo cuota) for the TARGET month. Every amount is
    already denominated in the requested currency (ADR-168), except the monotributo
    stream whose figure is always the AFIP-ARS cuota (ADR-177).

    Attributes:
        source: Whether the stream is a subscription, an instalment cuota, or the tax.
        posted: The committed amount this stream POSTED in the target month, or ``None``
            when it did not post (or a USD row lacked a snapshot, ADR-152). A posted
            stream is inside the month's Expenses total (ADR-179).
        expected: The stream's expected-this-month amount evaluated at offset 0 (its
            cadence lands this month / its instalment tail reaches this month), or
            ``None`` when it is not due this month or a USD snapshot is missing. Drives
            the pending side only while the stream has not yet posted (ADR-176/179).
        ars_fixed: ``True`` when the amount is an AFIP-fixed ARS figure that must never
            be re-denominated to USD (the monotributo cuota, ADR-177); such a stream is
            summed into a total ONLY on an ARS request and never counted as unconverted.
    """

    source: CommitmentSource
    posted: Decimal | None
    expected: Decimal | None
    ars_fixed: bool = False


def _by_source(
    subscription: Decimal,
    installment: Decimal,
    tax: Decimal,
) -> CommittedBySource:
    """Assemble a per-source breakdown, quantizing each figure and their sum (ADR-025)."""
    subscription = _money(subscription)
    installment = _money(installment)
    tax = _money(tax)
    return CommittedBySource(
        subscription=subscription,
        installment=installment,
        tax=tax,
        total=_money(subscription + installment + tax),
    )


def build_committed(
    month: str,
    currency: str,
    *,
    streams: list[CommittedStream],
    unconverted: int,
) -> CommittedSplit:
    """Assemble the committed-spend paid/pending split for the target month (ADR-179).

    For each committed stream, the already-posted amount joins the PAID side (already
    inside the month's Expenses total) and the expected-this-month amount joins the
    PENDING side ONLY while the stream has not yet posted — the offset-0 no-double-count
    rule (ADR-176): once a row lands this month the stream is paid and never also
    pending (ADR-179). Both sides are broken out by source (subscription / installment /
    tax).

    The monotributo cuota is an AFIP-fixed ARS figure (ADR-177): it is summed into a
    paid/pending total ONLY when ``currency == "ARS"``; on a USD request it is never
    re-denominated into the USD totals and never touches ``unconverted``. A non-tax
    stream whose amount is ``None`` (a USD row lacking a snapshot, ADR-152) contributes
    nothing — the exclusion is already reflected in ``unconverted``.

    Args:
        month: The target month as ``YYYY-MM``, echoed back.
        currency: The requested denomination currency (``ARS`` / ``USD``), echoed back.
        streams: The committed streams with their target-month posted/expected figures.
        unconverted: Count of committed streams excluded from a USD denomination for
            lacking a snapshot; always ``0`` on the ARS path (ADR-152/168).

    Returns:
        The assembled :class:`CommittedSplit`.
    """
    paid = dict.fromkeys(CommitmentSource, _ZERO)
    pending = dict.fromkeys(CommitmentSource, _ZERO)

    for stream in streams:
        # An AFIP-fixed ARS cuota is summed only on an ARS request; a USD request never
        # re-denominates it into the USD totals (ADR-177).
        if stream.ars_fixed and currency != CURRENCY_ARS:
            continue

        if stream.posted is not None:
            # Posted this month → paid; it flips OUT of pending (no double-count, ADR-179).
            paid[stream.source] += stream.posted
        elif stream.expected is not None:
            # Not yet posted but expected this month → pending (offset-0 rule, ADR-176).
            pending[stream.source] += stream.expected

    return CommittedSplit(
        month=month,
        currency=currency,
        paid=_by_source(
            paid[CommitmentSource.SUBSCRIPTION],
            paid[CommitmentSource.INSTALLMENT],
            paid[CommitmentSource.TAX],
        ),
        pending=_by_source(
            pending[CommitmentSource.SUBSCRIPTION],
            pending[CommitmentSource.INSTALLMENT],
            pending[CommitmentSource.TAX],
        ),
        unconverted=unconverted,
    )
