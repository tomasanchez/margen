"""The receivables domain: ``Person``, ``ReceivableItem``, ``ReceivablePayment``, ``ReceivableAllocation`` (ADR-203, ADR-204, ADR-205).

Receivables track money owed **to** the owner — the conceptual inverse of the
:class:`~margen_api.domain.models.debt.Debt` aggregate (money the owner owes, ADR-187).
A :class:`Person` is a debtor the owner tracks; each of their itemized debts is a
:class:`ReceivableItem` (with an optional free-text justification and an optional
:class:`ReceivableInstallment` schedule), and incoming paybacks are
:class:`ReceivablePayment` events allocated across one or more items via
:class:`ReceivableAllocation` (ADR-204, ADR-206).

These are plain Python aggregates — no Pydantic, no SQLAlchemy, no I/O — that enforce
their own invariants in the lenient ADR-031 style, mirroring :class:`Debt` and
:class:`Transfer`. All money is ARS-only for v1 and stored as ``Decimal`` (ADR-025/034);
crucially, **nothing here carries an ``account_id``** — receivables are structurally
excluded from balance and net-worth aggregation by construction (ADR-205), so no money
that has not actually been received can ever leak into a balance sum.

An item may optionally be repaid in installments (cuotas, ADR-214): it then owns a
schedule of :class:`ReceivableInstallment` rows whose amounts always sum to the item's
``amount`` (ADR-216). A schedule is created from an :class:`InstallmentPlan` — the even
split with the rounding remainder on the last cuota, monthly due dates — and individual
cuotas can be edited, pardoned or targeted by an allocation afterwards (ADR-216, ADR-221).

An item may also carry a reference-only ``source_transaction_id`` pointing at the expense it
came from (ADR-217). It is display/traceability metadata only: it never nets anything out of
net worth, budgets or category spend (ADR-219) — that remains
``transactions.offsets_transaction_id``'s job, a deliberately separate mechanism (ADR-159).

How much is outstanding as of a date is computed by
:mod:`margen_api.domain.models.receivable_settlement` from these aggregates plus their
allocations (ADR-206, ADR-215); the aggregates here enforce their own invariants.
"""

from __future__ import annotations

from calendar import monthrange
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import (
    LOCKED_BY_ALLOCATIONS,
    LOCKED_BY_PARDONS,
    EmptyNameError,
    InstallmentAllocationTargetError,
    InstallmentAmountBelowPaidError,
    InstallmentScheduleLockedError,
    InvalidAmountError,
    InvalidInstallmentScheduleError,
    ReceivableInstallmentNotFoundError,
    ReceivableItemNotFoundError,
)
from margen_api.domain.models.value_objects import PaymentSource

ZERO = Decimal("0")
CENTS = Decimal("0.01")

# A schedule splits a debt into at least two cuotas; a single cuota is just a flat item (ADR-216).
MIN_INSTALLMENTS = 2


@dataclass(eq=False)
class Person:
    """A debtor the owner tracks receivables against, the aggregate root (ADR-204).

    A person is a durable identity the owner names once; their itemized debts and
    paybacks key off this ``id`` (ADR-204), which is also what the fuzzy income matcher
    matches an income transaction's name against (ADR-207). It is a manual, standalone
    record — no ``account_id``, so it can never enter net-worth aggregation (ADR-205).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        name: Required human label (e.g. "Juan"); trimmed and never empty (mirrors the
            transaction/debt name invariant, ADR-024).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every person is attributable and every read can be
            scoped to its owner (ADR-130). A plain carried field, not a domain invariant;
            ``None`` only for legacy/unowned construction.
        created_at: Server-managed creation timestamp.
    """

    id: UUID
    name: str
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        # Hard invariant: name is a required, non-empty display label (ADR-024 style).
        self.name = self.name.strip() if isinstance(self.name, str) else self.name
        if not self.name:
            raise EmptyNameError


@dataclass(eq=False)
class ReceivableInstallment:
    """One cuota of a receivable item's installment schedule (ADR-214).

    A child of :class:`ReceivableItem`, never persisted or loaded on its own (the item is the
    unit the repository reads and writes). ``index`` is its 1-based position in the plan,
    ``due_on`` the date from which it counts as owed (ADR-215), and ``amount`` a positive ARS
    magnitude normalized to cents (``NUMERIC(18, 2)``, ADR-025) so the schedule sums to the
    item amount exactly. ``pardoned_at`` mirrors the item-level pardon at the cuota grain
    (ADR-210, ADR-221): stamped when the owner forgives just this cuota, cleared on un-pardon.
    No ``account_id`` (ADR-205).

    Attributes:
        id: Stable UUID identity, generated client-side (ADR-026, ADR-223).
        item_id: The owning :class:`ReceivableItem`'s id.
        index: The cuota's 1-based position in its plan.
        due_on: The calendar date the cuota falls due.
        amount: The positive ARS magnitude of the cuota, in cents.
        pardoned_at: When the owner forgave this cuota, or ``None`` when it is still owed.
        created_at: Server-managed creation timestamp.
    """

    id: UUID
    item_id: UUID
    index: int
    due_on: date
    amount: Decimal
    pardoned_at: datetime | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        # Hard invariant: a cuota is a positive money magnitude, normalized to the stored cents
        # precision so the schedule's sum round-trips exactly (ADR-025, ADR-216).
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        self.amount = self.amount.quantize(CENTS, rounding=ROUND_HALF_UP)
        if self.amount <= ZERO:
            raise InvalidAmountError(self.amount)
        if self.index < 1:
            reason = f"a cuota index starts at 1, got {self.index}"
            raise InvalidInstallmentScheduleError(reason)

    @property
    def pardoned(self) -> bool:
        """Report whether the owner has forgiven this cuota (ADR-221)."""
        return self.pardoned_at is not None


@dataclass(frozen=True, slots=True)
class InstallmentPlan:
    """The shape of a cuota schedule the owner asks for: how many, starting when (ADR-216).

    A plan is what the owner enters — the number of cuotas and the first due date; the
    schedule (:func:`build_installment_schedule`) is what the domain derives from it plus the
    item total. Comparing an item's current :attr:`ReceivableItem.plan` against a requested
    one tells whether a revision re-shapes the schedule.

    Attributes:
        count: The number of cuotas (``N``), at least :data:`MIN_INSTALLMENTS`.
        first_due_on: The due date of cuota 1; later cuotas fall due monthly from it.
    """

    count: int
    first_due_on: date

    def __post_init__(self) -> None:
        """Enforce the minimum plan length (ADR-216)."""
        if self.count < MIN_INSTALLMENTS:
            reason = f"a schedule needs at least {MIN_INSTALLMENTS} cuotas, got {self.count}"
            raise InvalidInstallmentScheduleError(reason)


@dataclass(frozen=True, slots=True)
class InstallmentAdjustment:
    """A tweak to one cuota of a freshly split plan, applied as the item is created (ADR-216).

    Lets the owner enter a plan whose cuotas are not all equal — interest on the last one, a
    different first due date — in the same atomic write that creates the item, instead of a
    create followed by separate cuota edits. ``None`` keeps the even-split value.

    Attributes:
        index: The 1-based cuota to adjust; must exist in the plan.
        amount: The cuota's amount instead of its even share, or ``None``.
        due_on: The cuota's due date instead of the monthly one, or ``None``.
    """

    index: int
    amount: Decimal | None = None
    due_on: date | None = None


@dataclass(eq=False)
class ReceivableItem:
    """One itemized debt a :class:`Person` owes the owner (ADR-204).

    ``amount`` is a positive ARS magnitude (ADR-025); ``detail`` is the optional
    free-text justification the owner recorded for this specific debt (ADR-204/206),
    treated as absent when blank. The item belongs to exactly one person and carries no
    ``account_id`` (ADR-205). Its outstanding remainder is a query-side roll-up computed by
    :mod:`~margen_api.domain.models.receivable_settlement`, not stored here (ADR-206).

    A pardon is a **reversible** per-item state (ADR-210): when the owner forgives the item,
    ``pardoned_at`` is stamped with the moment of forgiveness; un-pardoning clears it back to
    ``None``. A pardoned item drops out of what the person owes (it is excluded from the
    person's outstanding roll-up and is no longer a valid allocation target, amending
    ADR-206) yet is retained so it can be shown on the shareable statement as "covered by
    you" (ADR-209 amend). It carries no ``account_id`` either way (ADR-205), so forgiving a
    debt still never touches a balance. Whether an item is pardoned is derived by
    :attr:`pardoned`; the timestamp is a plain carried fact, not a domain invariant.

    **Installments** (ADR-214): an item may own a schedule of ``N >= 2`` cuotas numbered
    ``1..N``. The schedule's amounts always sum to ``amount`` — once a schedule exists the item
    amount is derived from it, never entered independently (ADR-216). Allocation and pardon
    then target cuotas rather than the item (ADR-221), so an installment item never carries an
    item-level ``pardoned_at``: forgiving it forgives its remaining cuotas instead. A flat item
    (no cuotas) behaves exactly as before.

    Attributes:
        id: Stable UUID identity (ADR-026).
        person_id: The owning :class:`Person`'s id; the consistency parent (ADR-204).
        occurred_on: The real calendar date the debt was incurred; backdating allowed
            (the matcher windows income candidates from the earliest such date, ADR-207).
        amount: The positive ARS magnitude owed for this item (ADR-025); for an installment
            item, the sum of its cuotas.
        detail: Optional free-text justification; ``None`` when unset or blank.
        created_at: Server-managed creation timestamp.
        pardoned_at: When the owner forgave this (flat) item, or ``None`` when it is not
            pardoned (the reversible pardon state, ADR-210). Always ``None`` on an
            installment item, whose pardon lives on its cuotas (ADR-221).
        source_transaction_id: The expense this debt came from, or ``None`` (ADR-217). A
            reference only — it never moves a balance, budget or category spend (ADR-219).
            The same-owner + ``kind='expense'`` checks are application-layer (ADR-217).
        installments: The cuota schedule ordered by ``index``; empty for a flat item.
    """

    id: UUID
    person_id: UUID
    occurred_on: date
    amount: Decimal
    detail: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    pardoned_at: datetime | None = None
    source_transaction_id: UUID | None = None
    installments: tuple[ReceivableInstallment, ...] = ()

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        # Hard invariant: the amount owed is a positive money magnitude (ADR-025).
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        if self.amount <= ZERO:
            raise InvalidAmountError(self.amount)
        # ``detail`` is an optional free-form justification; trim it, blank means absent.
        if isinstance(self.detail, str):
            self.detail = self.detail.strip() or None
        self.installments = tuple(sorted(self.installments, key=lambda installment: installment.index))
        # Hard invariants of an installment item (ADR-214, ADR-216, ADR-221).
        violation = _schedule_violation(self) if self.installments else None
        if violation is not None:
            raise InvalidInstallmentScheduleError(violation)

    @property
    def pardoned(self) -> bool:
        """Report whether the owner has forgiven this item (ADR-210).

        A pardoned item is excluded from the person's outstanding and rejected as an
        allocation target; un-pardoning restores it. Derived from ``pardoned_at`` so the two
        can never disagree. Always ``False`` for an installment item, whose forgiveness is
        tracked per cuota (ADR-221).
        """
        return self.pardoned_at is not None

    @property
    def has_schedule(self) -> bool:
        """Report whether the item is repaid in installments (ADR-214)."""
        return bool(self.installments)

    @property
    def plan(self) -> InstallmentPlan | None:
        """Return the plan the current schedule has (count + cuota 1's due date), or ``None``.

        ``None`` for a flat item. Used to tell whether a requested plan re-shapes the
        schedule (ADR-216).
        """
        if not self.installments:
            return None
        return InstallmentPlan(count=len(self.installments), first_due_on=self.installments[0].due_on)

    def installment_at(self, index: int) -> ReceivableInstallment:
        """Return the cuota at ``index`` (1-based).

        Raises:
            ReceivableInstallmentNotFoundError: When the item has no cuota with that index
                (including a flat item, which has none).
        """
        for installment in self.installments:
            if installment.index == index:
                return installment
        raise ReceivableInstallmentNotFoundError(self.id, index)

    def has_same_terms(self, other: ReceivableItem) -> bool:
        """Report whether ``other`` describes the same debt as this item (ADR-204, ADR-216).

        Compares what an item is created with — person, date, amount, detail, expense link and
        the cuota schedule (index, due date, amount) — ignoring identities, timestamps and the
        pardon state, which later actions change. Used to recognize a retried creation.
        """
        return (
            self.person_id == other.person_id
            and self.occurred_on == other.occurred_on
            and self.amount == other.amount
            and self.detail == other.detail
            and self.source_transaction_id == other.source_transaction_id
            and _schedule_terms(self.installments) == _schedule_terms(other.installments)
        )

    def check_allocation_target(self, installment_id: UUID | None) -> None:
        """Enforce who an allocation to this item may target (ADR-210, ADR-221, ADR-223).

        The application-layer guard for the mixed-mode invariant no portable CHECK can express
        (ADR-223): an installment item must be paid cuota by cuota, a flat item as a whole.

        Args:
            installment_id: The cuota the allocation names, or ``None`` for the item itself.

        Raises:
            ReceivableItemNotFoundError: When this flat item is pardoned — a forgiven item is
                not a valid allocation target and is reported as absent, exactly as before
                (ADR-210).
            InstallmentAllocationTargetError: When an installment item is targeted without a
                cuota, or a flat item with one.
            ReceivableInstallmentNotFoundError: When the named cuota is not one of this item's
                cuotas or is pardoned (a forgiven cuota is not payable, ADR-221).
        """
        if not self.installments:
            if installment_id is not None:
                raise InstallmentAllocationTargetError(self.id, requires_installment=False)
            if self.pardoned:
                raise ReceivableItemNotFoundError(self.id)
            return
        if installment_id is None:
            raise InstallmentAllocationTargetError(self.id, requires_installment=True)
        if not any(installment.id == installment_id and not installment.pardoned for installment in self.installments):
            raise ReceivableInstallmentNotFoundError(self.id, installment_id)

    def revise(
        self,
        *,
        amount: Decimal | None,
        plan: InstallmentPlan | None,
        has_allocations: bool,
        created_at: datetime,
        new_id: Callable[[], UUID] = uuid4,
    ) -> ReceivableItem:
        """Return the item with its amount and/or cuota plan revised (ADR-216).

        ``plan`` is the plan the item should end up with (``None`` = a flat item). When the
        plan and the total are both unchanged, the item is returned as is, so re-sending the
        current plan never wipes per-cuota edits. A flat item that stays flat simply takes the
        new amount (the pre-installment behavior). Anything else re-shapes the schedule — a
        new count or first due date, a new total on an installment item, or a conversion to or
        from installments — and regenerates the cuotas from the even split; that is refused
        while the plan is locked (see :class:`InstallmentScheduleLockedError`).

        Args:
            amount: The new total, or ``None`` to keep the current one.
            plan: The plan the item should have afterwards; ``None`` for a flat item.
            has_allocations: Whether any payment allocation already targets this item.
            created_at: The creation timestamp stamped on regenerated cuotas.
            new_id: Identity factory for regenerated cuotas (the handler injects ids).

        Returns:
            The revised item; ``self`` when nothing changes.

        Raises:
            InstallmentScheduleLockedError: When the schedule would change shape while the
                item has allocations or a pardon.
            InvalidInstallmentScheduleError: When the total is too small for the plan.
        """
        total = amount if amount is not None else self.amount
        if plan == self.plan and total == self.amount:
            return self
        if plan is None and not self.installments:
            return replace(self, amount=total)
        self._ensure_schedule_can_change(has_allocations=has_allocations)
        if plan is None:
            return replace(self, amount=total, installments=())
        schedule = build_installment_schedule(
            item_id=self.id, total=total, plan=plan, created_at=created_at, new_id=new_id
        )
        return replace(self, amount=_schedule_total(schedule), installments=schedule)

    def edit_installment(
        self,
        index: int,
        *,
        amount: Decimal | None = None,
        due_on: date | None = None,
        paid_by_installment: Mapping[UUID, Decimal],
    ) -> ReceivableItem:
        """Return the item with one cuota's amount and/or due date edited (ADR-216).

        Models interest or a recargo applied after the fact: the cuota keeps its identity (so
        any allocation to it stays attached) and the item amount is re-derived as the sum of
        the cuotas. Allowed whether or not the plan has allocations — only its shape is locked —
        but a cuota can never be lowered below what was already paid toward it: that would turn
        the excess into a hidden negative remainder.

        Args:
            index: The 1-based cuota to edit.
            amount: The cuota's new amount, or ``None`` to keep it.
            due_on: The cuota's new due date, or ``None`` to keep it.
            paid_by_installment: The amount already allocated to each cuota, by cuota id.

        Raises:
            ReceivableInstallmentNotFoundError: When the item has no cuota at ``index``.
            InvalidAmountError: When the new amount is not a positive cents magnitude.
            InstallmentAmountBelowPaidError: When the new amount is below what was paid.
        """
        current = self.installment_at(index)
        edited = replace(
            current,
            amount=amount if amount is not None else current.amount,
            due_on=due_on if due_on is not None else current.due_on,
        )
        paid = paid_by_installment.get(current.id, ZERO)
        if amount is not None and edited.amount < paid:
            raise InstallmentAmountBelowPaidError(self.id, index, paid, edited.amount)
        return self._with_installments(
            tuple(edited if installment.index == index else installment for installment in self.installments)
        )

    def set_installment_pardon(self, index: int, *, pardoned_at: datetime | None) -> ReceivableItem:
        """Return the item with one cuota pardoned (stamped) or un-pardoned (cleared) (ADR-221).

        Raises:
            ReceivableInstallmentNotFoundError: When the item has no cuota at ``index``.
        """
        self.installment_at(index)
        return self._with_installments(
            tuple(
                replace(installment, pardoned_at=pardoned_at) if installment.index == index else installment
                for installment in self.installments
            )
        )

    def set_pardon(
        self,
        *,
        pardoned: bool,
        at: datetime,
        paid_by_installment: Mapping[UUID, Decimal],
    ) -> ReceivableItem:
        """Return the item forgiven or restored as a whole (ADR-210, ADR-221).

        A flat item takes or clears the item-level stamp. On an installment item the whole
        remaining plan is the target: pardoning stamps every cuota that still owes money
        (``amount`` minus what was paid toward it is positive) and is not already pardoned —
        paid cuotas stay paid and earlier pardons keep their original moment — while
        un-pardoning clears every cuota's pardon.

        Args:
            pardoned: ``True`` to forgive, ``False`` to restore.
            at: The moment of forgiveness to stamp.
            paid_by_installment: The amount already allocated to each cuota, by cuota id.
        """
        if not self.installments:
            return replace(self, pardoned_at=at if pardoned else None)
        if not pardoned:
            return self._with_installments(
                tuple(replace(installment, pardoned_at=None) for installment in self.installments)
            )
        return self._with_installments(
            tuple(
                replace(installment, pardoned_at=at)
                if not installment.pardoned
                and installment.amount - paid_by_installment.get(installment.id, ZERO) > ZERO
                else installment
                for installment in self.installments
            )
        )

    def _with_installments(self, installments: tuple[ReceivableInstallment, ...]) -> ReceivableItem:
        """Return a copy carrying ``installments`` with the amount re-derived from them (ADR-216)."""
        return replace(self, installments=installments, amount=_schedule_total(installments))

    def _ensure_schedule_can_change(self, *, has_allocations: bool) -> None:
        """Refuse a schedule re-shape while allocations or pardons pin the current cuotas (ADR-216).

        Raises:
            InstallmentScheduleLockedError: When the item has any allocation, or the item or
                any of its cuotas is pardoned.
        """
        if has_allocations:
            raise InstallmentScheduleLockedError(self.id, LOCKED_BY_ALLOCATIONS)
        if self.pardoned or any(installment.pardoned for installment in self.installments):
            raise InstallmentScheduleLockedError(self.id, LOCKED_BY_PARDONS)


@dataclass(eq=False)
class ReceivablePayment:
    """An incoming payback event from a :class:`Person`, allocated across items (ADR-204, ADR-206).

    ``amount`` is a positive ARS magnitude (ADR-025). ``source`` records how the payment
    was captured: ``manual`` (typed by hand) or ``matched_income`` (a confirmed fuzzy
    income match, ADR-207), in which case ``matched_income_transaction_id`` links the
    ``kind='income'`` transaction it was matched to. The link/source coupling
    (matched payments carry an id, manual ones do not; an income is claimed once linked)
    is enforced by the application layer (ADR-207), not as a domain invariant — mirroring
    how ownership and offset-target checks stay application-side (ADR-130, ADR-159). The
    payment carries no ``account_id``, so a payback never touches a balance (ADR-205).

    Attributes:
        id: Stable UUID identity (ADR-026).
        person_id: The paying :class:`Person`'s id; the consistency parent (ADR-204).
        occurred_on: The real calendar date the payback was received; backdating allowed.
        amount: The positive ARS magnitude received (ADR-025).
        source: Whether the payment was recorded manually or from a matched income
            (ADR-207); parsed to a :class:`PaymentSource`.
        matched_income_transaction_id: The linked income transaction's id for a
            ``matched_income`` payment; ``None`` for a ``manual`` one (ADR-207).
        created_at: Server-managed creation timestamp.
    """

    id: UUID
    person_id: UUID
    occurred_on: date
    amount: Decimal
    source: PaymentSource = PaymentSource.MANUAL
    matched_income_transaction_id: UUID | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.source = PaymentSource.parse(self.source)
        # Hard invariant: the amount received is a positive money magnitude (ADR-025).
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        if self.amount <= ZERO:
            raise InvalidAmountError(self.amount)


@dataclass(eq=False)
class ReceivableAllocation:
    """A slice of a :class:`ReceivablePayment` applied to one :class:`ReceivableItem` (ADR-204, ADR-206).

    The many-to-one join (ADR-204) that lets a single payment settle several items and an
    item be paid down across several payments (ADR-206). ``amount`` is a positive ARS
    magnitude (ADR-025); the over-allocation guard (a payment's allocations must not
    exceed its amount, and the person's total must not silently exceed outstanding) is an
    application/UI-layer concern surfaced as a confirm-time warning (ADR-206), not a hard
    domain invariant. Carries no ``account_id`` (ADR-205).

    For an installment item the slice settles one specific cuota, named by
    ``installment_id``; for a flat item it is ``None`` (ADR-221). That "required iff the item
    has a schedule" rule spans two rows, so it is enforced when the payment is recorded
    (:meth:`ReceivableItem.check_allocation_target`), not here (ADR-223).

    Attributes:
        id: Stable UUID identity (ADR-026).
        payment_id: The :class:`ReceivablePayment` this slice draws from (ADR-204).
        item_id: The :class:`ReceivableItem` this slice pays down (ADR-204).
        amount: The positive ARS magnitude applied from the payment to the item (ADR-025).
        installment_id: The cuota this slice settles on an installment item, else ``None``.
    """

    id: UUID
    payment_id: UUID
    item_id: UUID
    amount: Decimal
    installment_id: UUID | None = None

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        # Hard invariant: an allocation applies a positive money magnitude (ADR-025).
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        if self.amount <= ZERO:
            raise InvalidAmountError(self.amount)


def build_person(
    *,
    name: str,
    user_id: str | None = None,
    person_id: UUID | None = None,
    created_at: datetime | None = None,
) -> Person:
    """Construct a valid :class:`Person`, generating identity and timestamp.

    The domain stays pure: identity and timestamp default here only as a convenience.
    The application handler injects ``id`` and ``created_at`` so the domain performs no
    implicit clock or UUID reads in production (ADR-026). Invariants run inside
    ``Person.__post_init__``.

    Args:
        name: Required human label; trimmed and must be non-empty.
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise (ADR-130).
        person_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Person`` aggregate.

    Raises:
        EmptyNameError: When ``name`` is empty or only whitespace.
    """
    return Person(
        id=person_id if person_id is not None else uuid4(),
        name=name,
        user_id=user_id,
        created_at=created_at if created_at is not None else datetime.now(UTC),
    )


def build_receivable_item(
    *,
    person_id: UUID,
    occurred_on: date,
    amount: Decimal,
    detail: str | None = None,
    item_id: UUID | None = None,
    created_at: datetime | None = None,
    pardoned_at: datetime | None = None,
    source_transaction_id: UUID | None = None,
    plan: InstallmentPlan | None = None,
    adjustments: Sequence[InstallmentAdjustment] = (),
    new_installment_id: Callable[[], UUID] = uuid4,
) -> ReceivableItem:
    """Construct a valid :class:`ReceivableItem`, generating identity and timestamp.

    Identity and timestamp default here only as a convenience; the handler injects them
    in production (ADR-026). Invariants run inside ``ReceivableItem.__post_init__``. When a
    ``plan`` is given the item is created with its cuota schedule (ADR-214, ADR-216): the
    even split of ``amount`` (normalized to cents) across ``plan.count`` monthly cuotas, then
    each of the ``adjustments`` applied to its cuota, the item amount being the resulting
    schedule's exact sum.

    Args:
        person_id: The owning :class:`Person`'s id.
        occurred_on: The real calendar date the debt was incurred.
        amount: The positive ARS magnitude owed for this item.
        detail: Optional free-text justification; ``None`` when unset.
        item_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        pardoned_at: When the item was forgiven, or ``None`` when it is not pardoned
            (the reversible pardon state, ADR-210).
        source_transaction_id: The expense the debt came from, or ``None`` (ADR-217).
        plan: The cuota plan to split the debt into, or ``None`` for a flat item.
        adjustments: Per-cuota tweaks to the even split; each index at most once, within the
            plan.
        new_installment_id: Identity factory for the generated cuotas.

    Returns:
        A validated, normalized ``ReceivableItem``.

    Raises:
        InvalidAmountError: When ``amount`` (or an adjusted cuota amount) is not a positive
            magnitude.
        InvalidInstallmentScheduleError: When ``amount`` is too small to split into the
            plan's cuotas, a pardoned item is given a plan, or an adjustment names a cuota the
            plan does not have, names one twice, or comes without a plan.
    """
    resolved_id = item_id if item_id is not None else uuid4()
    resolved_created_at = created_at if created_at is not None else datetime.now(UTC)
    schedule: tuple[ReceivableInstallment, ...] = ()
    if plan is not None:
        schedule = build_installment_schedule(
            item_id=resolved_id,
            total=amount,
            plan=plan,
            created_at=resolved_created_at,
            new_id=new_installment_id,
        )
    item = ReceivableItem(
        id=resolved_id,
        person_id=person_id,
        occurred_on=occurred_on,
        amount=_schedule_total(schedule) if schedule else amount,
        detail=detail,
        created_at=resolved_created_at,
        pardoned_at=pardoned_at,
        source_transaction_id=source_transaction_id,
        installments=schedule,
    )
    return _adjusted(item, adjustments)


def _adjusted(item: ReceivableItem, adjustments: Sequence[InstallmentAdjustment]) -> ReceivableItem:
    """Apply creation-time cuota adjustments to a freshly split item (ADR-216).

    Raises:
        InvalidInstallmentScheduleError: When an adjustment comes without a schedule, names a
            cuota the plan does not have, or names one twice.
    """
    indexes = [adjustment.index for adjustment in adjustments]
    if len(set(indexes)) != len(indexes):
        reason = "each cuota can be adjusted at most once"
        raise InvalidInstallmentScheduleError(reason)
    for adjustment in adjustments:
        if not 1 <= adjustment.index <= len(item.installments):
            reason = f"there is no cuota {adjustment.index} in a plan of {len(item.installments)}"
            raise InvalidInstallmentScheduleError(reason)
        # Nothing is paid on an item being created, so no cuota has a paid floor yet.
        item = item.edit_installment(
            adjustment.index,
            amount=adjustment.amount,
            due_on=adjustment.due_on,
            paid_by_installment={},
        )
    return item


def monthly_due_date(first_due_on: date, offset: int) -> date:
    """Return the due date ``offset`` months after ``first_due_on`` (ADR-216).

    Keeps the first cuota's day of the month, clamped to the target month's last day (a plan
    starting on the 31st falls due on the 28th/29th in February, and back on the 31st in
    March) — each date is derived from ``first_due_on``, so clamping never accumulates.

    Args:
        first_due_on: The due date of cuota 1.
        offset: How many months later (``0`` returns ``first_due_on``).

    Returns:
        The clamped due date ``offset`` months later.
    """
    month_index = first_due_on.month - 1 + offset
    year = first_due_on.year + month_index // 12
    month = month_index % 12 + 1
    return date(year, month, min(first_due_on.day, monthrange(year, month)[1]))


def split_evenly(total: Decimal, count: int) -> tuple[Decimal, ...]:
    """Split ``total`` into ``count`` cents amounts, the rounding remainder on the LAST (ADR-216).

    Every share but the last is ``total / count`` rounded DOWN to cents; the last takes
    whatever remains, so the shares always sum to ``total`` exactly and the last is never
    smaller than the others (e.g. ``1000 / 3`` -> ``333.33, 333.33, 333.34``).

    Args:
        total: A cents-precision amount to split.
        count: The number of shares (positive).

    Returns:
        The ``count`` shares in order.
    """
    share = (total / count).quantize(CENTS, rounding=ROUND_DOWN)
    return (*([share] * (count - 1)), total - share * (count - 1))


def build_installment_schedule(
    *,
    item_id: UUID,
    total: Decimal,
    plan: InstallmentPlan,
    created_at: datetime | None = None,
    new_id: Callable[[], UUID] = uuid4,
) -> tuple[ReceivableInstallment, ...]:
    """Derive a cuota schedule from a plan and the item total — PURE (ADR-214, ADR-216).

    The total is normalized to cents (half-up, like every money figure here), split evenly
    with the remainder on the last cuota (:func:`split_evenly`), and the cuotas fall due
    monthly from ``plan.first_due_on`` (:func:`monthly_due_date`). The cuotas therefore sum to
    the normalized total exactly; the caller uses that sum as the item amount.

    Args:
        item_id: The owning item's id, stamped on every cuota.
        total: The positive item total to split.
        plan: How many cuotas and when the first falls due.
        created_at: The creation timestamp for the cuotas; defaults to now (UTC).
        new_id: Identity factory for the cuotas (ids are generated client-side, ADR-223).

    Returns:
        The cuotas ordered by index ``1..N``.

    Raises:
        InvalidInstallmentScheduleError: When the total cannot give every cuota at least one
            cent.
    """
    cents_total = Decimal(str(total)).quantize(CENTS, rounding=ROUND_HALF_UP)
    if cents_total < CENTS * plan.count:
        reason = f"{cents_total} cannot be split into {plan.count} positive cuotas"
        raise InvalidInstallmentScheduleError(reason)
    stamp = created_at if created_at is not None else datetime.now(UTC)
    return tuple(
        ReceivableInstallment(
            id=new_id(),
            item_id=item_id,
            index=offset + 1,
            due_on=monthly_due_date(plan.first_due_on, offset),
            amount=share,
            created_at=stamp,
        )
        for offset, share in enumerate(split_evenly(cents_total, plan.count))
    )


def _schedule_violation(item: ReceivableItem) -> str | None:
    """Return which installment-item invariant ``item`` breaks, or ``None`` (ADR-214, ADR-216, ADR-221).

    A schedule has at least two cuotas indexed exactly ``1..N``, all owned by the item and
    summing to its amount; an installment item is forgiven through its cuotas, never with an
    item-level pardon.
    """
    installments = item.installments
    if len(installments) < MIN_INSTALLMENTS:
        return f"a schedule needs at least {MIN_INSTALLMENTS} cuotas"
    if [installment.index for installment in installments] != list(range(1, len(installments) + 1)):
        return "cuota indexes must run 1..N without gaps or repeats"
    if any(installment.item_id != item.id for installment in installments):
        return "every cuota must belong to the item"
    if _schedule_total(installments) != item.amount:
        return "the cuotas must sum to the item amount"
    if item.pardoned_at is not None:
        return "an installment item is pardoned through its cuotas"
    return None


def _schedule_terms(installments: tuple[ReceivableInstallment, ...]) -> list[tuple[int, date, Decimal]]:
    """Return a schedule's terms — (index, due date, amount) per cuota — without identities."""
    return [(installment.index, installment.due_on, installment.amount) for installment in installments]


def _schedule_total(installments: tuple[ReceivableInstallment, ...]) -> Decimal:
    """Return the sum of a schedule's cuota amounts — the derived item amount (ADR-216)."""
    return sum((installment.amount for installment in installments), ZERO)


def build_receivable_payment(
    *,
    person_id: UUID,
    occurred_on: date,
    amount: Decimal,
    source: PaymentSource | str = PaymentSource.MANUAL,
    matched_income_transaction_id: UUID | None = None,
    payment_id: UUID | None = None,
    created_at: datetime | None = None,
) -> ReceivablePayment:
    """Construct a valid :class:`ReceivablePayment`, generating identity and timestamp.

    Identity and timestamp default here only as a convenience; the handler injects them
    in production (ADR-026). Invariants run inside ``ReceivablePayment.__post_init__``.

    Args:
        person_id: The paying :class:`Person`'s id.
        occurred_on: The real calendar date the payback was received.
        amount: The positive ARS magnitude received.
        source: ``manual`` or ``matched_income``, as a :class:`PaymentSource` or string
            (ADR-207).
        matched_income_transaction_id: The linked income transaction's id for a
            matched-income payment; ``None`` otherwise (ADR-207).
        payment_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``ReceivablePayment``.

    Raises:
        InvalidAmountError: When ``amount`` is not a positive magnitude.
        UnknownPaymentSourceError: When ``source`` is not a known payment source.
    """
    return ReceivablePayment(
        id=payment_id if payment_id is not None else uuid4(),
        person_id=person_id,
        occurred_on=occurred_on,
        amount=amount,
        source=PaymentSource.parse(source),
        matched_income_transaction_id=matched_income_transaction_id,
        created_at=created_at if created_at is not None else datetime.now(UTC),
    )


def build_receivable_allocation(
    *,
    payment_id: UUID,
    item_id: UUID,
    amount: Decimal,
    allocation_id: UUID | None = None,
    installment_id: UUID | None = None,
) -> ReceivableAllocation:
    """Construct a valid :class:`ReceivableAllocation`, generating identity.

    Identity defaults here only as a convenience; the handler injects it in production
    (ADR-026). Invariants run inside ``ReceivableAllocation.__post_init__``.

    Args:
        payment_id: The :class:`ReceivablePayment` this slice draws from.
        item_id: The :class:`ReceivableItem` this slice pays down.
        amount: The positive ARS magnitude applied.
        allocation_id: Optional identity; generated when omitted.
        installment_id: The cuota this slice settles on an installment item (ADR-221);
            ``None`` for a flat item.

    Returns:
        A validated, normalized ``ReceivableAllocation``.

    Raises:
        InvalidAmountError: When ``amount`` is not a positive magnitude.
    """
    return ReceivableAllocation(
        id=allocation_id if allocation_id is not None else uuid4(),
        payment_id=payment_id,
        item_id=item_id,
        amount=amount,
        installment_id=installment_id,
    )
