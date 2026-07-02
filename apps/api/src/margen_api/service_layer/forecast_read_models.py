"""Read models for the cash-flow forecast query side (ADR-176, ADR-177).

Purpose-built, immutable DTOs for the schedule/commitment-driven forecast's single
``GET /reports/forecast`` response — deliberately separate from the write aggregates
so the query side evolves independently (AGENTS.md reader ports + read models). The
forecast v1 projects only COMMITTED future outflows (recurring subscriptions,
instalment tails and the monotributo monthly cuota); there is no discretionary band
and no projected income yet (ADR-176), so a month's ``total`` equals its ``committed``
figure. Money is :class:`~decimal.Decimal` (ADR-025) and every figure is denominated in
the requested currency by the reader (ADR-168); the ``unconverted`` count surfaces the
committed rows a USD denomination excluded for lacking an FX snapshot so a USD total is
never silently understated (ADR-152/168).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum


class CommitmentSource(StrEnum):
    """Where a forecast commitment line comes from (ADR-176, ADR-177).

    Attributes:
        SUBSCRIPTION: A flagged recurring expense stream (``recurring=true``) whose
            latest observed amount repeats on its cadence (ADR-176).
        INSTALLMENT: An instalment plan (``recurring_cadence='installment'``) whose
            remaining payments are projected forward (ADR-176).
        TAX: The configured monotributo monthly cuota — a committed AFIP-ARS tax
            outflow in every future month (ADR-177).
    """

    SUBSCRIPTION = "subscription"
    INSTALLMENT = "installment"
    TAX = "tax"


@dataclass(frozen=True, slots=True)
class CommitmentLine:
    """One committed outflow stream projected across the forecast horizon (ADR-176).

    Powers the "upcoming commitments" and "installments tail" UI: each line is a
    distinct committed stream (a subscription, an instalment plan, or the monotributo
    cuota) with the months it lands in and its per-occurrence amount.

    Attributes:
        source: Whether the stream is a subscription, an instalment tail, or the tax.
        label: A human label for the stream (the transaction name, or a tax label).
        amount: The per-occurrence committed amount in the requested currency.
        currency: The denomination the amount is expressed in (``ARS`` / ``USD``).
        months: The forecast months (``YYYY-MM``, oldest-first) this stream lands a
            payment in — only months strictly after the stream's latest actual (no
            double-count, ADR-176).
        remaining_count: For an instalment tail, the number of payments still to come
            (``installments_total - installments_index``); ``None`` for a subscription
            or the recurring tax stream (ADR-176).
        ars_fixed: ``True`` when the amount is an AFIP-fixed ARS figure that must never
            be re-denominated to USD (the monotributo cuota, ADR-177); ``False`` for
            subscriptions and instalment tails, whose amount follows the requested
            currency. A USD forecast surfaces an ``ars_fixed`` line as its own ARS
            figure OUTSIDE the USD month total (ADR-177).
    """

    source: CommitmentSource
    label: str
    amount: Decimal
    currency: str
    months: list[str]
    remaining_count: int | None = None
    ars_fixed: bool = False


@dataclass(frozen=True, slots=True)
class ForecastMonth:
    """One forecast month's committed outflow total in the requested currency (ADR-176).

    Attributes:
        month: Calendar month as ``YYYY-MM``.
        committed: The month's SUM of committed outflows (subscriptions + instalment
            tails + the monotributo cuota) in the requested currency.
        total: The month's total projected outflow. In v1 this equals ``committed``
            (no discretionary band yet, ADR-176), carried as a distinct field so the
            frontend contract is stable when a discretionary band is added later.
        confidence: ``'committed'`` when the month's figure is entirely committed
            outflows; ``'estimated'`` reserved for a later discretionary band. Always
            ``'committed'`` in v1 (ADR-176).
    """

    month: str
    committed: Decimal
    total: Decimal
    confidence: str


@dataclass(frozen=True, slots=True)
class ForecastSeries:
    """The full schedule/commitment-driven cash-flow forecast payload (ADR-176, ADR-177).

    Attributes:
        horizon: The number of forward months projected (clamped 1..12, default 6).
        currency: The denomination currency (``ARS`` / ``USD``), echoed back.
        months: The oldest-first per-month committed-outflow series over the horizon,
            starting the month AFTER the current month.
        commitments: The distinct committed streams (subscriptions, instalment tails
            and the monotributo cuota) feeding the series, for the "upcoming
            commitments" + "installments tail" UI.
        unconverted: Count of committed rows excluded from a USD denomination for
            lacking an FX snapshot; always ``0`` on the ARS path (ADR-152/168).
    """

    horizon: int
    currency: str
    months: list[ForecastMonth]
    commitments: list[CommitmentLine]
    unconverted: int
