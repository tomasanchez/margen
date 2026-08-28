"""Repository port for the write side of the receivables cluster (ADR-204, ADR-206, ADR-130).

Ports describe the persistence contract application handlers depend on, keeping the
handlers free of SQLAlchemy. The concrete adapter lives under ``margen_api.adapters``
(AGENTS.md). The repository serves the write model only; query paths use the reader port
(ADR-028).

The :class:`~margen_api.domain.models.receivable.Person` is the aggregate root and the
consistency boundary: items, payments and allocations hang off it, so this single
repository spans all four record types rather than fragmenting one aggregate across four
repositories. Ownership always flows through the person's ``user_id`` — a foreign owner's
id is treated as absent so the boundary answers 404 (ADR-111, ADR-130). ``item_remainders``
is a write-side read the record-payment handler needs to enforce the ADR-206 overpayment
guard within the same transaction.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from decimal import Decimal
from uuid import UUID

from margen_api.domain.models.receivable import (
    Person,
    ReceivableAllocation,
    ReceivableItem,
    ReceivablePayment,
)


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
    def add_item(self, item: ReceivableItem) -> None:
        """Stage a new receivable item for persistence on the next commit.

        The item's ownership is inherited through its ``person_id``; the handler has
        already verified the person belongs to the owner (ADR-130).

        Args:
            item: The item to persist.
        """

    @abstractmethod
    async def get_item(self, item_id: UUID, user_id: str) -> ReceivableItem | None:
        """Load one of the owner's items by identity, or ``None`` (ADR-130, ADR-111).

        Ownership is resolved by joining the item to its person and scoping by the
        person's ``user_id``.

        Args:
            item_id: The item identity.
            user_id: The authenticated owner the item's person must belong to.

        Returns:
            The item, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist_item(self, item: ReceivableItem) -> None:
        """Apply the state of a mutated item to its stored row (update semantics).

        Args:
            item: The mutated item to persist.
        """

    @abstractmethod
    async def delete_item(self, item_id: UUID, user_id: str) -> bool:
        """Hard-delete one of the owner's items by identity (ADR-204, ADR-130).

        Scoped to the owner through the item's person: a cross-tenant delete removes
        nothing and reports a miss, so the boundary answers 404 (ADR-111). The database
        cascades the item's allocations away (ADR-208).

        Args:
            item_id: The item identity.
            user_id: The authenticated owner the item's person must belong to.

        Returns:
            ``True`` when a row was removed, ``False`` when none matched for this owner.
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
    async def item_remainders(self, person_id: UUID) -> dict[UUID, Decimal]:
        """Return each of the person's items keyed to its outstanding remainder (ADR-206).

        A write-side read the record-payment handler uses to enforce the overpayment
        guard within the same transaction: the dict keys are exactly the person's item
        ids (so an allocation targeting an id not present is a not-found), and each value
        is ``item.amount`` - Σ the item's existing allocations. The person's outstanding
        is the sum of the values.

        Args:
            person_id: The person whose items to sum; already ownership-verified by the
                handler through :meth:`get_person`.

        Returns:
            A mapping of item id to remaining amount; empty when the person has no items.
        """
