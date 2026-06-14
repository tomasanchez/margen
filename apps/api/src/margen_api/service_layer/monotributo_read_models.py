"""Read models for the Monotributo query side (ADR-046, ADR-047, ADR-052).

Purpose-built, immutable DTOs for the Monotributo page: a live trailing-12-month
``current`` standing, an optional prior-window ``previous`` standing for the
period-over-period comparison, the A-K reference ``scale`` table, and the
``invoices`` drilldown of the included rows. These are deliberately separate from
the transaction write aggregate so the query side evolves independently (AGENTS.md
reader ports + read models). Money is carried as :class:`~decimal.Decimal`
(ADR-025); the API boundary serializes it the same Decimal style the transactions
endpoint uses (ADR-030).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True, slots=True)
class MonotributoStanding:
    """A trailing-12-month Monotributo standing (ADR-046).

    Attributes:
        category: The category letter (A-K) in effect for the window.
        activity_type: ``"services"`` or ``"bienes"`` (MVP uses services).
        limit: The category's annual ceiling in ARS (the bar ``used`` is measured
            against).
        used: SUM of the included invoices over the trailing-12-month window.
        remaining: ``limit - used`` (the margin left before the ceiling); may be
            negative when over the limit.
        percent_used: ``used / limit * 100``; ``0`` when ``limit`` is ``0``.
        status: Status band key (``safe`` / ``watch`` / ``close`` / ``over``).
        projected_category: Smallest category whose ceiling covers the linearly
            annualized income (the projection's landing band).
        projection_note: Calm, plain-language note explaining the projection is an
            estimate that assumes a steady pace.
        period_start: First day of the trailing-12-month window.
        period_end: Last day of the trailing-12-month window (``today`` for the
            live current standing).
    """

    category: str
    activity_type: str
    limit: Decimal
    used: Decimal
    remaining: Decimal
    percent_used: Decimal
    status: str
    projected_category: str
    projection_note: str
    period_start: date
    period_end: date


@dataclass(frozen=True, slots=True)
class MonotributoScaleEntry:
    """One A-K reference row in the Monotributo scale table (ADR-048).

    Attributes:
        letter: The category letter, ``"A"`` through ``"K"``.
        annual_ceiling: Maximum trailing-12-month gross income for the category.
        cuota_servicios: Monthly all-in cuota for a services taxpayer.
        cuota_bienes: Monthly all-in cuota for a goods taxpayer.
    """

    letter: str
    annual_ceiling: Decimal
    cuota_servicios: Decimal
    cuota_bienes: Decimal


@dataclass(frozen=True, slots=True)
class MonotributoInvoice:
    """One included invoice in the trailing-12-month drilldown (ADR-046).

    The drilldown makes the figure transparent: each counted invoice with a
    ``cumulative`` running total toward the limit so the user can see exactly which
    rows pushed the standing toward the ceiling.

    Attributes:
        id: The transaction identity.
        occurred_on: Calendar date the invoice happened.
        name: Human display label.
        category: Category label, or ``None`` when uncategorized.
        amount: Positive ARS-equivalent magnitude that counted toward the limit.
        currency: ``ARS`` or ``USD`` (the original currency of the row).
        cumulative: Running SUM of ``amount`` through this row, oldest-first.
        is_foreign_currency: Whether the row was originally in a non-ARS currency
            (a small transparency hint; the counted ``amount`` is ARS-equivalent).
    """

    id: UUID
    occurred_on: date
    name: str
    category: str | None
    amount: Decimal
    currency: str
    cumulative: Decimal
    is_foreign_currency: bool


@dataclass(frozen=True, slots=True)
class MonotributoSnapshot:
    """The full Monotributo page payload (ADR-052).

    Attributes:
        current: The live trailing-12-month standing computed from transactions.
        previous: The prior trailing-12-month standing (window ending 12 months
            ago) for the comparison toggle, or ``None`` when no data exists.
        scale: The A-K reference scale rows.
        invoices: The included-invoice drilldown for the current window,
            oldest-first with a running cumulative.
    """

    current: MonotributoStanding
    previous: MonotributoStanding | None
    scale: list[MonotributoScaleEntry]
    invoices: list[MonotributoInvoice]
