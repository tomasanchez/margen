"""Repository port for the write side of the receivables cluster (ADR-204, ADR-206, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. The concrete adapter lives under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader port
(ADR-028).

The :class:`~margen_api.domain.models.receivable.Person` is the aggregate root and the
consistency boundary: items, payments and allocations hang off it, so this single
repository spans all four record types rather than fragmenting one aggregate across four
repositories. Ownership always flows through the person's ``user_id`` — a foreign owner's
id is treated as absent so the boundary answers 404 (ADR-111, ADR-130). An item is loaded
and saved together with its cuota schedule (ADR-214) — cuotas are children of the item, never
persisted on their own (ADR 0013). ``list_items`` and ``allocated_amounts`` are write-side
reads the handlers need inside the same transaction: the ADR-206 overpayment guard (assessed
as of a date, ADR-215), the cuota-targeting rules (ADR-221) and the plan lock (ADR-216).

Concurrency: every write handler first calls :meth:`AbstractReceivableRepository.lock_person`,
which takes a row lock on the person (the aggregate root) for the rest of the transaction.
Two writes on the same person's receivables therefore run one after the other, so the checks
a handler makes (has this plan been paid? is this an overpayment?) still hold when it writes,
and no write is computed from a stale snapshot (lost update).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.domain.models.receivable import (
    Person,
    ReceivableAllocation,
    ReceivableItem,
    ReceivablePayment,
)
from margen_api.domain.models.receivable_settlement import ItemAllocations


class AbstractReceivableRepository(ABC):
    """Collection-like async store for the receivables cluster (ADR-204, ADR-130)."""

    @abstractmethod
    def add_person(self, person: Person) -> None:
        """Stage a new person for persistence on the next commit.

        Ownership rides on the aggregate (``person.user_id``), copied onto the row so
        every insert is attributed to the authenticated owner (ADR-130).

        Args:
            person: The aggregate root to persist.
        """

    @abstractmethod
    async def get_person(self, person_id: UUID, user_id: str) -> Person | None:
        """Load one of the owner's people by identity, or ``None`` (ADR-130, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the handler
        then surfaces a not-found (404 at the boundary, ADR-111).

        Args:
            person_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The person, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def lock_person(self, person_id: UUID, user_id: str) -> Person | None:
        """Load one of the owner's people and lock it until the transaction ends (ADR-130).

        The aggregate-root lock serializing every write on the person's receivables: a
        concurrent writer blocks here until this transaction commits or rolls back, then reads
        the state it left. Must be the first read of a write handler. Scoped to ``user_id`` so
        a foreign owner's id is treated as absent (ADR-111). Adapters without row locks (the
        SQLite test tier) may treat it as a plain load.

        Args:
            person_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The locked person, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist_person(self, person: Person) -> None:
        """Apply the state of a mutated person to its stored row (rename semantics).

        Args:
            person: The mutated aggregate root to persist.
        """

    @abstractmethod
    async def delete_person(self, person_id: UUID, user_id: str) -> bool:
        """Hard-delete one of the owner's people by identity (ADR-204, ADR-130).

        Scoped to ``user_id``: a row owned by another user is not matched, so the delete
        reports a miss and the boundary answers 404 (ADR-111). The database cascades the
        person's items and payments (and their allocations) away (ADR-208).

        Args:
            person_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched for this owner.
        """

    @abstractmethod
    async def add_item(self, item: ReceivableItem) -> None:
        """Stage a new receivable item, with its cuota schedule, for the next commit.

        The item's ownership is inherited through its ``person_id``; the handler has
        already verified the person belongs to the owner (ADR-130). Asynchronous because an
        adapter may need to flush the item before its cuotas so their foreign key resolves.

        Args:
            item: The item to persist, including its ``installments`` (ADR-214).
        """

    @abstractmethod
    async def get_item(self, item_id: UUID, user_id: str) -> ReceivableItem | None:
        """Load one of the owner's items by identity, or ``None`` (ADR-130, ADR-111).

        Ownership is resolved by joining the item to its person and scoping by the
        person's ``user_id``. The item comes back with its cuota schedule and expense link.

        Args:
            item_id: The item identity.
            user_id: The authenticated owner the item's person must belong to.

        Returns:
            The item, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist_item(self, item: ReceivableItem) -> None:
        """Apply the state of a mutated item, and its cuota schedule, to storage (update semantics).

        Cuotas present on the item are updated in place (same id) or inserted; stored cuotas
        the item no longer carries are removed (a re-schedule, ADR-216).

        Args:
            item: The mutated item to persist.
        """

    @abstractmethod
    async def delete_item(self, item_id: UUID, person_id: UUID) -> bool:
        """Hard-delete one of a person's items by identity (ADR-204, ADR-130).

        Scoped to the person, which the handler has already locked — and so verified to belong
        to the owner: an item of another person (or another owner) is not matched and the
        delete reports a miss, so the boundary answers 404 (ADR-111). The database cascades
        the item's cuotas and allocations away (ADR-208).

        Args:
            item_id: The item identity.
            person_id: The locked person the item must belong to.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched for this person.
        """

    @abstractmethod
    def add_payment(self, payment: ReceivablePayment) -> None:
        """Stage a new payback event for persistence on the next commit.

        Ownership is inherited through the payment's ``person_id``; the handler has
        already verified the person belongs to the owner (ADR-130).

        Args:
            payment: The payment to persist.
        """

    @abstractmethod
    def add_allocation(self, allocation: ReceivableAllocation) -> None:
        """Stage one payment-to-item allocation for persistence on the next commit.

        Args:
            allocation: The allocation slice to persist.
        """

    @abstractmethod
    async def income_exists_for_owner(self, income_id: UUID, user_id: str) -> bool:
        """Return whether an income transaction exists for the owner (ADR-207, ADR-130).

        A write-side read the record-payment handler uses to validate a confirm-match's
        ``matched_income_transaction_id`` within the same transaction, BEFORE staging the
        payment (ADR-207). ``True`` only when a transaction with that id belongs to
        ``user_id`` AND has ``kind='income'``. A missing row, one owned by another user, or
        one of a different kind all return ``False`` so the handler surfaces a single
        not-found (404 at the boundary, existence never leaked, ADR-111).

        Args:
            income_id: The linked income transaction id supplied by the confirm-match flow.
            user_id: The authenticated owner the income must belong to.

        Returns:
            ``True`` when the caller owns an income transaction with that id, else ``False``.
        """

    @abstractmethod
    async def income_is_claimed(self, income_id: UUID, user_id: str) -> bool:
        """Return whether an income is already linked to one of the owner's payments (ADR-207).

        A write-side read enforcing the ADR-207 "claimed" invariant inside the record-payment
        transaction: a confirmed income backs at most one ``receivable_payment``, so a second
        confirm of the same income must be rejected (409 at the boundary) rather than settling
        two debts from one real income. Scoped to the owner by resolving each payment back to
        its person (the only ownership column, ADR-130).

        Args:
            income_id: The linked income transaction id supplied by the confirm-match flow.
            user_id: The authenticated owner whose payments the claimed set is drawn from.

        Returns:
            ``True`` when the income already backs one of the owner's payments, else ``False``.
        """

    @abstractmethod
    async def expense_exists_for_owner(self, transaction_id: UUID, user_id: str) -> bool:
        """Return whether an expense transaction exists for the owner (ADR-217, ADR-130).

        A write-side read the add/edit-item handlers use to validate an item's
        ``source_transaction_id`` link before staging it. ``True`` only when a transaction
        with that id belongs to ``user_id`` AND has ``kind='expense'``; a missing row, one
        owned by another user, or one of another kind all return ``False`` so the handler
        surfaces a single not-found (404, existence never leaked, ADR-111).

        Args:
            transaction_id: The expense the item wants to reference.
            user_id: The authenticated owner the expense must belong to.

        Returns:
            ``True`` when the caller owns an expense transaction with that id, else ``False``.
        """

    @abstractmethod
    async def item_exists(self, item_id: UUID) -> bool:
        """Return whether ANY item, of any owner, already uses this id (ADR-204).

        Lets the add-item handler refuse a client-chosen id that is taken outside the caller's
        own items with a clean conflict, instead of a primary-key violation. Reveals nothing
        beyond the id being taken.

        Args:
            item_id: The client-chosen item identity.

        Returns:
            ``True`` when a receivable item with that id exists.
        """

    @abstractmethod
    async def list_items(self, person_id: UUID) -> list[ReceivableItem]:
        """Return every item of the person, each with its cuota schedule (ADR-206, ADR-214).

        A write-side read the record-payment handler uses to check each allocation's target
        (ADR-221) and to assess the person's outstanding for the overpayment guard. Pardoned
        items are included — whether one is a valid target is the domain's call.

        Args:
            person_id: The person whose items to load; already ownership-verified by the
                handler through :meth:`get_person`.

        Returns:
            The person's items in any order; empty when the person has none.
        """

    @abstractmethod
    async def allocated_amounts(self, person_id: UUID) -> dict[UUID, ItemAllocations]:
        """Return how much has been allocated to each of the person's items (ADR-206, ADR-221).

        Each value carries the item's allocation total and, for an installment item, the
        per-cuota totals. Feeds the overpayment guard, the plan lock (any allocation pins the
        plan's shape, ADR-216) and the whole-plan pardon (which skips paid cuotas).

        Args:
            person_id: The person whose allocations to sum; already ownership-verified.

        Returns:
            A mapping of item id to its allocations; items nobody paid toward are absent.
        """
