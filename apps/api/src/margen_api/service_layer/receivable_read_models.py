"""Read models for the receivables query side (ADR-204, ADR-206, ADR-130).

Purpose-built, immutable DTOs for the receivables surface — deliberately separate from the
write aggregates so the two evolve independently (AGENTS.md reader ports + read models).
Money is :class:`~decimal.Decimal` (ADR-025), ARS-only for v1; the API boundary serializes
it as the same Decimal style the rest of the app uses (ADR-030).

The roll-ups these carry are the settlement figures computed query-side over the persisted
rows by the pure :mod:`~margen_api.domain.models.receivable_settlement` policy, as of a date
the caller supplies: an item's ``remaining`` = ``amount`` - Σ its allocations; its
``due_outstanding`` is what it owes now (the whole remainder of a flat item, only the due
cuotas of an installment item, ADR-215) and ``upcoming_total`` its not-yet-due cuotas; a
person's ``outstanding`` / ``upcoming_total`` sum those. Nothing here carries an
``account_id`` — receivables never enter net-worth aggregation (ADR-205).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from margen_api.domain.models.receivable_settlement import InstallmentStatus
from margen_api.domain.models.value_objects import Currency

_ZERO = Decimal(0)


def expense_plan_total(amount: Decimal, installments_total: int | None) -> Decimal:
    """Return what a linked expense stands for in full: its whole card plan, else itself (ADR-218).

    A card-cuota expense (the ``N`` of an ``N/M`` plan, ADR-174) is one of ``M`` equal charges,
    so the purchase people split is ``amount x M``; any other expense stands for its own amount.
    Comparing linked receivables against the single cuota would flag every split purchase.
    """
    return amount * installments_total if installments_total else amount


@dataclass(frozen=True, slots=True)
class ReceivableInstallmentReadModel:
    """Query-optimized projection of one cuota with its as-of settlement state (ADR-214, ADR-215).

    Attributes:
        id: The cuota's stable identity — what a payment allocation targets (ADR-221).
        index: The cuota's 1-based position in its plan.
        due_on: The date the cuota falls due.
        amount: The cuota's ARS amount.
        paid: The sum allocated to this cuota so far.
        remaining: ``amount`` - ``paid``; negative once overpaid.
        pardoned: Whether the owner forgave this cuota (ADR-221).
        status: ``due`` / ``upcoming`` / ``paid`` / ``pardoned`` as of the read's date.
    """

    id: UUID
    index: int
    due_on: date
    amount: Decimal
    paid: Decimal
    remaining: Decimal
    pardoned: bool
    status: InstallmentStatus


@dataclass(frozen=True, slots=True)
class SourceTransactionReadModel:
    """A summary of the expense an item references (ADR-217, ADR-218, ADR-219).

    Reference-only display data: the expense keeps counting at its full face value in every
    balance, budget and category-spend aggregation (ADR-219).

    Attributes:
        id: The expense transaction's identity.
        name: Its display label.
        occurred_on: The date it happened.
        amount: Its positive ARS-equivalent magnitude (the figure receivables compare to).
        currency: Its currency (ARS or USD).
        usd_amount: The native USD amount for a USD row, else ``None``.
        installments_index: Its cuota position (the ``N`` of ``N/M``) when it is a card cuota,
            else ``None`` (ADR-174).
        installments_total: Its plan length (the ``M`` of ``N/M``), else ``None`` (ADR-174).
        linked_items_total: The sum of every one of the owner's receivable items linking this
            expense, across all people (ADR-218).
    """

    id: UUID
    name: str
    occurred_on: date
    amount: Decimal
    currency: Currency
    usd_amount: Decimal | None
    installments_index: int | None
    installments_total: int | None
    linked_items_total: Decimal

    @property
    def plan_total(self) -> Decimal:
        """Return what the expense stands for in full — its card plan's total (:func:`expense_plan_total`)."""
        return expense_plan_total(self.amount, self.installments_total)

    @property
    def over_linked(self) -> bool:
        """Report whether the items linking the expense add up to more than its plan total (ADR-218).

        A non-blocking data-entry hint (e.g. someone was double-split), never a constraint. A
        card-cuota expense is compared on its whole plan, not the single cuota.
        """
        return self.linked_items_total > self.plan_total


@dataclass(frozen=True, slots=True)
class ReceivableItemReadModel:
    """Query-optimized projection of one itemized debt with its settlement roll-up (ADR-206).

    Attributes:
        id: Stable UUID identity.
        occurred_on: The calendar date the debt was incurred.
        amount: The positive ARS magnitude originally owed for this item (ADR-025); for an
            installment item, the sum of its cuotas (ADR-216).
        detail: The optional free-text justification, or ``None``.
        allocated: The sum of the payment allocations applied to this item so far.
        remaining: ``amount`` - ``allocated`` — the item's gross remainder over all its cuotas;
            may be negative once a confirmed overpayment credits the item beyond its amount
            (ADR-206). For a pardoned item this is the amount "covered by you" (ADR-210).
        pardoned: Whether the owner has forgiven this item (ADR-210). A pardoned item is
            excluded from the person's ``outstanding`` and is no longer a valid allocation
            target, but is retained so it can be shown as "covered by you". For an
            installment item: every cuota is paid or pardoned, at least one pardoned (ADR-221).
        due_outstanding: What the item contributes to the person's outstanding as of the read's
            date — the remainder of a non-pardoned flat item, the due cuotas' remainders of an
            installment item (ADR-215).
        upcoming_total: The not-yet-due cuotas' remainders; zero for a flat item (ADR-215).
        installments: The cuota schedule with each cuota's state; empty for a flat item.
        source_transaction: The linked expense's summary, or ``None`` when unlinked or the
            expense is gone (ADR-217).
        linked_total_exceeds_expense: Whether the items linking that expense sum to more than
            the expense — the non-blocking over-split warning (ADR-218).
    """

    id: UUID
    occurred_on: date
    amount: Decimal
    detail: str | None
    allocated: Decimal
    remaining: Decimal
    pardoned: bool = False
    due_outstanding: Decimal = _ZERO
    upcoming_total: Decimal = _ZERO
    installments: tuple[ReceivableInstallmentReadModel, ...] = ()
    source_transaction: SourceTransactionReadModel | None = None
    linked_total_exceeds_expense: bool = False


@dataclass(frozen=True, slots=True)
class ReceivablePaymentReadModel:
    """Query-optimized projection of one payback received from a person (ADR-206, ADR-209).

    Backs the shareable statement's "Payments received" section: the real money the person
    has paid back, both manual paybacks and confirmed income matches alike (no ``source``
    distinction, since both are money actually received). Deliberately minimal, carrying only
    what the paid-history section renders.

    Attributes:
        occurred_on: The calendar date the payback was received.
        amount: The positive ARS magnitude received (ADR-025).
    """

    occurred_on: date
    amount: Decimal


@dataclass(frozen=True, slots=True)
class PersonReadModel:
    """Query-optimized projection of a person and their outstanding total (ADR-204, ADR-206).

    Backs the people list: one row per debtor with the single roll-up the list needs.

    Attributes:
        id: Stable UUID identity.
        name: The debtor's display label.
        created_at: Server-managed creation timestamp (drives newest-first ordering).
        outstanding: Σ of the person's items' due outstanding — the money they owe now
            (ADR-206, ADR-215); may be negative after a confirmed overpayment credit.
        upcoming_total: Σ of their not-yet-due cuotas — informational, never owed yet (ADR-215).
    """

    id: UUID
    name: str
    created_at: datetime
    outstanding: Decimal
    upcoming_total: Decimal = _ZERO


@dataclass(frozen=True, slots=True)
class PersonDetailReadModel:
    """Query-optimized projection of one person with their per-item remainders (ADR-206).

    Backs the person detail surface: the debtor plus every itemized debt and its remainder,
    with the person-level outstanding total pre-summed for convenience.

    Attributes:
        id: Stable UUID identity.
        name: The debtor's display label.
        created_at: Server-managed creation timestamp.
        outstanding: Σ of the ``items``' due outstanding — what the person owes now (ADR-206,
            ADR-215); pardoned items and cuotas are excluded (ADR-210, ADR-221), and so are
            cuotas not yet due.
        items: The person's itemized debts with their per-item settlement roll-ups and
            pardon flag, newest-first by ``occurred_on`` (pardoned items included so the
            "covered by you" surface can render them, ADR-210).
        payments: The paybacks the person has made, newest-first by ``occurred_on`` — both
            manual and matched-income paybacks (ADR-206). Backs the statement's "Payments
            received" paid-history section (ADR-209); empty when the person has never paid.
        upcoming_total: Σ of the items' not-yet-due cuotas — informational (ADR-215, ADR-222).
    """

    id: UUID
    name: str
    created_at: datetime
    outstanding: Decimal
    items: tuple[ReceivableItemReadModel, ...]
    payments: tuple[ReceivablePaymentReadModel, ...] = ()
    upcoming_total: Decimal = _ZERO


@dataclass(frozen=True, slots=True)
class SuggestedAllocationLineReadModel:
    """One slice of the suggested allocation, shaped like a payment allocation (ADR-221).

    Attributes:
        item_id: The item the slice pays down.
        installment_id: The cuota it settles on an installment item, else ``None``.
        amount: The suggested amount.
    """

    item_id: UUID
    installment_id: UUID | None
    amount: Decimal


@dataclass(frozen=True, slots=True)
class SuggestedAllocationReadModel:
    """The default allocation of a payment amount over what a person owes now (ADR-221).

    Attributes:
        as_of: The date due-ness was assessed on.
        amount: The payment amount that was spread.
        lines: The suggested slices — due cuotas oldest first, then open flat items.
        allocated: Σ of the slices.
        unallocated: What nothing currently due could absorb.
    """

    as_of: date
    amount: Decimal
    lines: tuple[SuggestedAllocationLineReadModel, ...]
    allocated: Decimal
    unallocated: Decimal


@dataclass(frozen=True, slots=True)
class ExpenseCandidateReadModel:
    """One of the owner's expenses offered by the receivable link picker (ADR-220).

    Attributes:
        id: The expense transaction's identity.
        name: Its display label.
        occurred_on: The date it happened.
        amount: Its positive ARS-equivalent magnitude.
        currency: Its currency (ARS or USD).
        usd_amount: The native USD amount for a USD row, else ``None``.
        installments_index: Its card-cuota position, else ``None`` (ADR-174) — seeds the
            "Someone owes me this" cuota count prefill (ADR-220).
        installments_total: Its card-cuota plan length, else ``None`` (ADR-174).
        linked_items_total: Σ of the owner's receivable items already linking it (ADR-218).
    """

    id: UUID
    name: str
    occurred_on: date
    amount: Decimal
    currency: Currency
    usd_amount: Decimal | None
    installments_index: int | None
    installments_total: int | None
    linked_items_total: Decimal

    @property
    def plan_total(self) -> Decimal:
        """Return what the expense stands for in full — its card plan's total (:func:`expense_plan_total`)."""
        return expense_plan_total(self.amount, self.installments_total)
