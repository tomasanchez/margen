"""The receivables domain: ``Person``, ``ReceivableItem``, ``ReceivablePayment``, ``ReceivableAllocation`` (ADR-203, ADR-204, ADR-205).

Receivables track money owed **to** the owner — the conceptual inverse of the
:class:`~margen_api.domain.models.debt.Debt` aggregate (money the owner owes, ADR-187).
A :class:`Person` is a debtor the owner tracks; each of their itemized debts is a
:class:`ReceivableItem` (with an optional free-text justification), and incoming
paybacks are :class:`ReceivablePayment` events allocated across one or more items via
:class:`ReceivableAllocation` (ADR-204, ADR-206).

These are plain Python aggregates — no Pydantic, no SQLAlchemy, no I/O — that enforce
their own invariants in the lenient ADR-031 style, mirroring :class:`Debt` and
:class:`Transfer`. All money is ARS-only for v1 and stored as ``Decimal`` (ADR-025/034);
crucially, **nothing here carries an ``account_id``** — receivables are structurally
excluded from balance and net-worth aggregation by construction (ADR-205), so no money
that has not actually been received can ever leak into a balance sum.

An item's outstanding = ``item.amount`` minus the sum of its allocations; a person's
outstanding = the sum of each item's remainder (ADR-206). Those roll-ups are query-side
concerns, computed by a read model over the persisted rows — the aggregates here only
enforce per-row invariants.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import EmptyNameError, InvalidAmountError
from margen_api.domain.models.value_objects import PaymentSource

ZERO = Decimal("0")


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
class ReceivableItem:
    """One itemized debt a :class:`Person` owes the owner (ADR-204).

    ``amount`` is a positive ARS magnitude (ADR-025); ``detail`` is the optional
    free-text justification the owner recorded for this specific debt (ADR-204/206),
    treated as absent when blank. The item belongs to exactly one person and carries no
    ``account_id`` (ADR-205). Its outstanding remainder (``amount`` minus the sum of its
    allocations) is a query-side roll-up, not stored here (ADR-206).

    Attributes:
        id: Stable UUID identity (ADR-026).
        person_id: The owning :class:`Person`'s id; the consistency parent (ADR-204).
        occurred_on: The real calendar date the debt was incurred; backdating allowed
            (the matcher windows income candidates from the earliest such date, ADR-207).
        amount: The positive ARS magnitude owed for this item (ADR-025).
        detail: Optional free-text justification; ``None`` when unset or blank.
        created_at: Server-managed creation timestamp.
    """

    id: UUID
    person_id: UUID
    occurred_on: date
    amount: Decimal
    detail: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

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

    Attributes:
        id: Stable UUID identity (ADR-026).
        payment_id: The :class:`ReceivablePayment` this slice draws from (ADR-204).
        item_id: The :class:`ReceivableItem` this slice pays down (ADR-204).
        amount: The positive ARS magnitude applied from the payment to the item (ADR-025).
    """

    id: UUID
    payment_id: UUID
    item_id: UUID
    amount: Decimal

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
) -> ReceivableItem:
    """Construct a valid :class:`ReceivableItem`, generating identity and timestamp.

    Identity and timestamp default here only as a convenience; the handler injects them
    in production (ADR-026). Invariants run inside ``ReceivableItem.__post_init__``.

    Args:
        person_id: The owning :class:`Person`'s id.
        occurred_on: The real calendar date the debt was incurred.
        amount: The positive ARS magnitude owed for this item.
        detail: Optional free-text justification; ``None`` when unset.
        item_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``ReceivableItem``.

    Raises:
        InvalidAmountError: When ``amount`` is not a positive magnitude.
    """
    return ReceivableItem(
        id=item_id if item_id is not None else uuid4(),
        person_id=person_id,
        occurred_on=occurred_on,
        amount=amount,
        detail=detail,
        created_at=created_at if created_at is not None else datetime.now(UTC),
    )


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
) -> ReceivableAllocation:
    """Construct a valid :class:`ReceivableAllocation`, generating identity.

    Identity defaults here only as a convenience; the handler injects it in production
    (ADR-026). Invariants run inside ``ReceivableAllocation.__post_init__``.

    Args:
        payment_id: The :class:`ReceivablePayment` this slice draws from.
        item_id: The :class:`ReceivableItem` this slice pays down.
        amount: The positive ARS magnitude applied.
        allocation_id: Optional identity; generated when omitted.

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
    )
