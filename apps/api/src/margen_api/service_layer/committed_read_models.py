"""Read models for the committed-spend accent query side (ADR-179).

Purpose-built, immutable DTOs for the single ``GET /reports/committed`` response —
deliberately separate from the write aggregates so the query side evolves
independently (AGENTS.md reader ports + read models). The accent splits a month's
COMMITTED expense universe (recurring subscriptions + instalment cuotas + the
monotributo cuota, ADR-179) into two states — **paid** (committed rows already
posted this month, already inside the month's Expenses total) and **pending**
(expected-this-month committed outflows not yet posted, computed per stream at
offset 0 with the forecast's no-double-count rule, ADR-176/179).

Money is :class:`~decimal.Decimal` (ADR-025) and every figure is denominated in the
requested currency by the reader (ADR-168); the ``unconverted`` count surfaces the
committed rows a USD denomination excluded for lacking an FX snapshot so a USD total
is never silently understated (ADR-152/168). The per-source breakdown mirrors the
forecast's :class:`CommitmentSource` — subscription / installment / tax.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class CommittedBySource:
    """A committed figure broken out by its three sources (ADR-179).

    Both the paid and the pending sides carry one of these so the frontend can render
    the split per source (subscriptions, instalment cuotas, the monotributo tax cuota)
    without recomputing. The ``total`` is the sum of the three, kept explicit so the
    contract does not force the client to add them.

    Attributes:
        subscription: The recurring-subscription portion in the requested currency.
        installment: The instalment-cuota portion in the requested currency.
        tax: The monotributo-cuota portion — an AFIP-ARS figure summed only on an ARS
            request (ADR-177); ``0`` on a USD request (never re-denominated).
        total: The sum of ``subscription + installment + tax``.
    """

    subscription: Decimal
    installment: Decimal
    tax: Decimal
    total: Decimal


@dataclass(frozen=True, slots=True)
class CommittedSplit:
    """A month's committed spend split into paid vs pending, per source (ADR-179).

    Attributes:
        month: The target month as ``YYYY-MM``.
        currency: The denomination currency (``ARS`` / ``USD``), echoed back.
        paid: The committed rows already POSTED this month, already inside the
            month's Expenses total (ADR-179).
        pending: The expected-this-month committed outflows not yet posted — computed
            per stream at offset 0 with the no-double-count rule; a stream flips out of
            pending the moment its row lands this month (ADR-176/179).
        unconverted: Count of committed streams excluded from a USD denomination for
            lacking an FX snapshot; always ``0`` on the ARS path (ADR-152/168).
    """

    month: str
    currency: str
    paid: CommittedBySource
    pending: CommittedBySource
    unconverted: int
