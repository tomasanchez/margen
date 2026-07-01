"""Unit tests for the reimbursement offset-link validation (ADR-158, ADR-159, ADR-130).

A ``kind='reimbursement'`` transaction may link an ``offsets_transaction_id`` to the
EXPENSE it reduces (ADR-159). The create handler validates through the transaction
repository on the unit of work — mirroring the account-ownership guard (ADR-130) — and:

* raises :class:`OffsetTargetNotFoundError` (404 at the boundary) when the target is
  missing or owned by another user (a cross-owner link, ADR-111);
* raises :class:`OffsetTargetNotExpenseError` (422) when the target exists but is not
  an EXPENSE (an income / invoice / another reimbursement, ADR-159);
* persists the link when the target is one of the caller's own expenses.

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.transaction import CreateTransaction
from margen_api.domain.models.exceptions import (
    OffsetTargetNotExpenseError,
    OffsetTargetNotFoundError,
)
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind
from margen_api.service_layer.handlers import create_transaction
from tests.fakes.persistence import FakeUnitOfWork

A_DATE = date(2026, 6, 12)
A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed_transaction(uow: FakeUnitOfWork, *, kind: Kind = Kind.EXPENSE, user_id: str = A_USER) -> UUID:
    """Place a committed transaction of the given kind in the store and return its id."""
    transaction = build_transaction(
        transaction_id=uuid4(),
        occurred_on=A_DATE,
        name="Group dinner",
        kind=kind,
        amount=Decimal("10000"),
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_aggregates[transaction.id] = transaction
    return transaction.id


class TestReimbursementOffsetLink:
    """Creating a reimbursement with an offset link validates the target (ADR-159)."""

    async def test_links_own_expense(self):
        """
        GIVEN an expense owned by the caller
        WHEN a reimbursement is created offsetting that expense
        THEN the reimbursement is persisted carrying the offsets_transaction_id
        """
        # GIVEN
        uow = FakeUnitOfWork()
        expense_id = _seed_transaction(uow, kind=Kind.EXPENSE)

        # WHEN
        reimbursement_id = await create_transaction(
            CreateTransaction(
                occurred_on=A_DATE,
                name="Ana pays back",
                kind=Kind.REIMBURSEMENT,
                amount=Decimal("3000"),
                user_id=A_USER,
                offsets_transaction_id=expense_id,
            ),
            uow,
        )

        # THEN
        assert uow.committed_aggregates[reimbursement_id].offsets_transaction_id == expense_id

    async def test_missing_target_raises_not_found(self):
        """
        GIVEN no transaction with the referenced offset id
        WHEN a reimbursement is created linking it
        THEN OffsetTargetNotFoundError is raised and nothing is committed (ADR-159)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(OffsetTargetNotFoundError):
            await create_transaction(
                CreateTransaction(
                    occurred_on=A_DATE,
                    name="Ana pays back",
                    kind=Kind.REIMBURSEMENT,
                    amount=Decimal("3000"),
                    user_id=A_USER,
                    offsets_transaction_id=uuid4(),
                ),
                uow,
            )
        assert uow.committed_aggregates == {}

    async def test_foreign_expense_is_not_found(self):
        """
        GIVEN an expense owned by another user
        WHEN the caller creates a reimbursement offsetting it
        THEN OffsetTargetNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        foreign_expense = _seed_transaction(uow, kind=Kind.EXPENSE, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(OffsetTargetNotFoundError):
            await create_transaction(
                CreateTransaction(
                    occurred_on=A_DATE,
                    name="Ana pays back",
                    kind=Kind.REIMBURSEMENT,
                    amount=Decimal("3000"),
                    user_id=A_USER,
                    offsets_transaction_id=foreign_expense,
                ),
                uow,
            )

    async def test_non_expense_target_raises_not_expense(self):
        """
        GIVEN an income transaction owned by the caller
        WHEN a reimbursement links it as the offset target
        THEN OffsetTargetNotExpenseError is raised — a payback may only offset an expense (ADR-159)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        income_id = _seed_transaction(uow, kind=Kind.INCOME)

        # WHEN / THEN
        with pytest.raises(OffsetTargetNotExpenseError):
            await create_transaction(
                CreateTransaction(
                    occurred_on=A_DATE,
                    name="Ana pays back",
                    kind=Kind.REIMBURSEMENT,
                    amount=Decimal("3000"),
                    user_id=A_USER,
                    offsets_transaction_id=income_id,
                ),
                uow,
            )

    async def test_non_reimbursement_kind_ignores_offset_link(self):
        """
        GIVEN an offset id supplied on an ordinary income transaction
        WHEN it is created
        THEN the domain drops the link (it is meaningful only for a reimbursement, ADR-159)
             and no offset validation is performed (the target need not even exist)
        """
        # GIVEN — a non-existent offset id on an INCOME row; the domain forces it None,
        # so the handler's offset check is a no-op and the create succeeds.
        uow = FakeUnitOfWork()

        # WHEN
        transaction_id = await create_transaction(
            CreateTransaction(
                occurred_on=A_DATE,
                name="Salary",
                kind=Kind.INCOME,
                amount=Decimal("500000"),
                user_id=A_USER,
                offsets_transaction_id=uuid4(),
            ),
            uow,
        )

        # THEN
        assert uow.committed_aggregates[transaction_id].offsets_transaction_id is None
