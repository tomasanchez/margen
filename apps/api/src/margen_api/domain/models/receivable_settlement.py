"""As-of settlement figures for receivables: due vs. upcoming, outstanding, default allocation.

PURE domain policy — no I/O, no clock — shared by the write side (the record-payment
overpayment guard) and the read side (the people list, person detail and the suggested
allocation), so both always agree on what is owed (ADR-206, ADR-215, ADR-221).

* An item's **position** (:func:`assess_item`) is its settlement state on a given ``as_of``
  date, computed from the item and how much has been allocated to it.
* A **flat** item keeps ADR-206's formula: its whole remainder (``amount`` minus its
  allocations) counts toward outstanding at once, unless it is pardoned (ADR-210).
* An **installment** item counts only its DUE cuotas (ADR-215): the remainders of the
  non-pardoned cuotas whose ``due_on`` is on or before ``as_of``. Non-pardoned cuotas due
  later are **upcoming** — reported apart, never part of outstanding, so they neither inflate
  the overpayment-warning threshold nor the statement's hero balance. Upcoming is never
  negative: whatever was paid on a not-yet-due cuota beyond its amount is a credit, so it
  lowers outstanding like any other confirmed overpayment (ADR-206).
* A person's outstanding / upcoming are the sums over their items' positions.
* The **default allocation** (:func:`default_allocation`) fills a payment into the due, unpaid
  cuotas oldest due date first, then into the open flat items in the order the person detail
  lists them (newest first) — the order the client's former greedy seed used (ADR-221) — never
  beyond what the person owes overall, so it never trips its own overpayment warning.
* :func:`find_target_overrun` spots an allocation that would pay one item or cuota beyond what
  it still owes — a confirm-time warning, like the person-level overpayment (ADR-206).

``as_of`` is always passed in by the caller (the boundary injects "today", ADR-223), which
keeps the due/upcoming boundary deterministic and testable.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from margen_api.domain.models.receivable import ReceivableInstallment, ReceivableItem

ZERO = Decimal("0")


class InstallmentStatus(StrEnum):
    """Where one cuota stands as of a date (ADR-215, ADR-221).

    Precedence is ``pardoned`` (an explicit forgiveness), then ``paid`` (nothing left), then
    ``due`` / ``upcoming`` by comparing ``due_on`` with the as-of date.
    """

    DUE = "due"
    UPCOMING = "upcoming"
    PAID = "paid"
    PARDONED = "pardoned"


@dataclass(frozen=True, slots=True)
class ItemAllocations:
    """How much of the person's payments has been allocated to one item (ADR-206, ADR-221).

    Attributes:
        total: The sum of every allocation to the item (all cuotas, or the item itself).
        by_installment: The sum allocated to each cuota, keyed by cuota id; empty for a flat
            item.
    """

    total: Decimal = ZERO
    by_installment: Mapping[UUID, Decimal] = field(default_factory=dict)

    @property
    def exist(self) -> bool:
        """Report whether any allocation targets the item (each allocation is positive)."""
        return self.total > ZERO


# The allocations of an item nobody has paid toward yet.
NO_ALLOCATIONS = ItemAllocations()


@dataclass(frozen=True, slots=True)
class InstallmentPosition:
    """One cuota's settlement state as of a date (ADR-215, ADR-221).

    Attributes:
        installment: The cuota itself.
        paid: The sum allocated to this cuota.
        remaining: ``installment.amount - paid``; negative once overpaid.
        status: Due, upcoming, paid or pardoned as of the assessed date.
    """

    installment: ReceivableInstallment
    paid: Decimal
    remaining: Decimal
    status: InstallmentStatus


@dataclass(frozen=True, slots=True)
class ItemPosition:
    """One item's settlement state as of a date (ADR-206, ADR-215).

    Attributes:
        item: The item itself.
        allocated: The sum of every allocation to the item.
        remaining: ``item.amount - allocated``, the gross remainder over all cuotas (for a
            pardoned flat item, the amount covered by the owner, ADR-210).
        due_outstanding: What the item contributes to the person's outstanding as of the date:
            the flat remainder (zero when pardoned), or the due cuotas' remainders.
        upcoming_total: The not-yet-due cuotas' remainders (zero for a flat item).
        installments: The cuota positions in index order; empty for a flat item.
    """

    item: ReceivableItem
    allocated: Decimal
    remaining: Decimal
    due_outstanding: Decimal
    upcoming_total: Decimal
    installments: tuple[InstallmentPosition, ...] = ()

    @property
    def pardoned(self) -> bool:
        """Report whether the debt is forgiven as a whole (ADR-210, ADR-221).

        A flat item reports its own pardon. An installment item is forgiven once at least one
        of its cuotas is pardoned and none is still due or upcoming — every cuota is either
        paid or forgiven. Per-cuota pardons are visible on :attr:`installments`.
        """
        if not self.installments:
            return self.item.pardoned
        statuses = {position.status for position in self.installments}
        return InstallmentStatus.PARDONED in statuses and not statuses & {
            InstallmentStatus.DUE,
            InstallmentStatus.UPCOMING,
        }


@dataclass(frozen=True, slots=True)
class AllocationSuggestion:
    """One slice of a suggested allocation, shaped like a payment allocation (ADR-221).

    Attributes:
        item_id: The item the slice pays down.
        installment_id: The cuota it settles on an installment item, else ``None``.
        amount: The positive amount suggested for the slice.
    """

    item_id: UUID
    installment_id: UUID | None
    amount: Decimal


@dataclass(frozen=True, slots=True)
class TargetOverrun:
    """An allocation asking more of one item or cuota than it still owes (ADR-206, ADR-221).

    Attributes:
        item_id: The item the allocation targets.
        installment_id: The cuota it targets on an installment item, else ``None``.
        remaining: What the target still owes before this payment.
        requested: What the payment allocates to it in total.
    """

    item_id: UUID
    installment_id: UUID | None
    remaining: Decimal
    requested: Decimal


@dataclass(frozen=True, slots=True)
class DefaultAllocation:
    """The default way to spread a payment over what a person owes (ADR-221).

    Attributes:
        lines: The suggested slices, in fill order.
        unallocated: The part of the payment nothing currently due could absorb.
    """

    lines: tuple[AllocationSuggestion, ...]
    unallocated: Decimal

    @property
    def allocated(self) -> Decimal:
        """Return the sum of the suggested slices."""
        return sum((line.amount for line in self.lines), ZERO)


def installment_status(installment: ReceivableInstallment, remaining: Decimal, as_of: date) -> InstallmentStatus:
    """Classify a cuota as of ``as_of`` (ADR-215, ADR-221).

    Args:
        installment: The cuota to classify.
        remaining: What is still owed on it (``amount`` minus what was paid toward it).
        as_of: The reference date; a cuota due ON this date is already due.

    Returns:
        ``pardoned`` when forgiven, else ``paid`` when nothing remains, else ``due`` when
        ``due_on <= as_of``, else ``upcoming``.
    """
    if installment.pardoned:
        return InstallmentStatus.PARDONED
    if remaining <= ZERO:
        return InstallmentStatus.PAID
    if installment.due_on <= as_of:
        return InstallmentStatus.DUE
    return InstallmentStatus.UPCOMING


def assess_item(item: ReceivableItem, allocations: ItemAllocations, as_of: date) -> ItemPosition:
    """Compute an item's settlement position as of a date (ADR-206, ADR-210, ADR-215).

    Args:
        item: The item to assess.
        allocations: What has been allocated to it so far.
        as_of: The reference date splitting due from upcoming cuotas.

    Returns:
        The item's position; a flat item's ``due_outstanding`` is its whole remainder (zero
        when pardoned), an installment item's is the remainders of its non-pardoned cuotas due
        on or before ``as_of`` plus any credit paid beyond a later cuota, and the rest of its
        later cuotas is ``upcoming_total`` (never negative).
    """
    remaining = item.amount - allocations.total
    if not item.installments:
        return ItemPosition(
            item=item,
            allocated=allocations.total,
            remaining=remaining,
            due_outstanding=ZERO if item.pardoned else remaining,
            upcoming_total=ZERO,
        )
    positions: list[InstallmentPosition] = []
    due = ZERO
    upcoming = ZERO
    for installment in item.installments:
        paid = allocations.by_installment.get(installment.id, ZERO)
        left = installment.amount - paid
        positions.append(
            InstallmentPosition(
                installment=installment,
                paid=paid,
                remaining=left,
                status=installment_status(installment, left, as_of),
            )
        )
        if installment.pardoned:
            continue
        if installment.due_on <= as_of:
            due += left
        elif left >= ZERO:
            upcoming += left
        else:
            # Paid ahead beyond the cuota: the excess is a credit now, never negative upcoming.
            due += left
    return ItemPosition(
        item=item,
        allocated=allocations.total,
        remaining=remaining,
        due_outstanding=due,
        upcoming_total=upcoming,
        installments=tuple(positions),
    )


def person_outstanding(positions: Iterable[ItemPosition]) -> Decimal:
    """Return what a person owes as of the assessed date — Σ items' due outstanding (ADR-215)."""
    return sum((position.due_outstanding for position in positions), ZERO)


def person_upcoming(positions: Iterable[ItemPosition]) -> Decimal:
    """Return a person's not-yet-due cuota total — Σ items' upcoming (ADR-215)."""
    return sum((position.upcoming_total for position in positions), ZERO)


def default_allocation(positions: Iterable[ItemPosition], amount: Decimal) -> DefaultAllocation:
    """Spread a payment over what a person owes now, the ADR-221 default — PURE.

    Fills, up to ``amount``:

    1. every DUE cuota still owing (not pardoned, positive remainder, ``due_on`` on or before
       the assessed date), oldest due date first — ties broken by the older purchase
       (``occurred_on``), then the item id, then the lower cuota index;
    2. then every open flat item (not pardoned, positive remainder) newest first by
       ``occurred_on`` (ties by id, descending) — the order the person detail lists items in
       and the order the client's previous greedy seed filled them.

    Upcoming cuotas are never suggested: paying ahead is a deliberate manual choice (and
    exceeds the due-only outstanding, so it goes through the ADR-206 confirm warning). Nor does
    the suggestion ever exceed what the person owes overall (``max(0, outstanding)``): a credit
    the person already holds elsewhere is used up first, so the suggestion never trips the
    overpayment warning once posted back.

    Args:
        positions: The person's item positions, assessed as of the payment date.
        amount: The payment amount to spread.

    Returns:
        The suggested slices and whatever part of ``amount`` was left unallocated.
    """
    assessed = list(positions)
    left = min(amount, max(ZERO, person_outstanding(assessed)))
    lines: list[AllocationSuggestion] = []
    for item_id, installment_id, owed in _collectible_targets(assessed):
        if left <= ZERO:
            break
        take = min(owed, left)
        lines.append(AllocationSuggestion(item_id=item_id, installment_id=installment_id, amount=take))
        left -= take
    allocated = sum((line.amount for line in lines), ZERO)
    return DefaultAllocation(lines=tuple(lines), unallocated=amount - allocated)


def find_target_overrun(
    positions: Mapping[UUID, ItemPosition],
    requested: Mapping[tuple[UUID, UUID | None], Decimal],
) -> TargetOverrun | None:
    """Return the first target a payment would pay beyond what it owes, or ``None`` (ADR-206, ADR-221).

    Each requested total (summed over the payment's slices to the same item or cuota) is
    compared with the target's current remainder: a flat item's ``remaining``, or the cuota's.
    Exceeding it is the per-target twin of the person-level overpayment: a confirm-time warning
    the owner may override to record a credit on purpose, never a silent acceptance.

    Args:
        positions: The person's item positions, keyed by item id; every requested item must be
            present (targets were already validated).
        requested: The payment's total per ``(item_id, installment_id)`` target, in the order
            the allocations were given.

    Returns:
        The first overrun in request order, or ``None`` when every target can absorb its share.
    """
    for (item_id, installment_id), amount in requested.items():
        remaining = _target_remaining(positions[item_id], installment_id)
        if amount > remaining:
            return TargetOverrun(
                item_id=item_id,
                installment_id=installment_id,
                remaining=remaining,
                requested=amount,
            )
    return None


def _target_remaining(position: ItemPosition, installment_id: UUID | None) -> Decimal:
    """Return what one allocation target still owes: the cuota's remainder, else the item's."""
    for cuota in position.installments:
        if cuota.installment.id == installment_id:
            return cuota.remaining
    return position.remaining


def _collectible_targets(positions: list[ItemPosition]) -> list[tuple[UUID, UUID | None, Decimal]]:
    """Order what is collectible now into ``(item_id, installment_id, owed)`` fill targets (ADR-221)."""
    due_cuotas = sorted(
        (
            (position.item, cuota)
            for position in positions
            for cuota in position.installments
            if cuota.status is InstallmentStatus.DUE
        ),
        key=lambda pair: (pair[1].installment.due_on, pair[0].occurred_on, pair[0].id, pair[1].installment.index),
    )
    open_flat_items = sorted(
        (
            position
            for position in positions
            if not position.item.installments and not position.item.pardoned and position.remaining > ZERO
        ),
        key=lambda position: (position.item.occurred_on, position.item.id),
        reverse=True,
    )
    return [(item.id, cuota.installment.id, cuota.remaining) for item, cuota in due_cuotas] + [
        (position.item.id, None, position.remaining) for position in open_flat_items
    ]
