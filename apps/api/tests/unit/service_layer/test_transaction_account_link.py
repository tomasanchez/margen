"""Unit tests for the transaction handlers' account-ownership check (ADR-122, ADR-130).

A transaction may only be linked to an account the authenticated caller owns. The
create/update handlers verify ownership through the account repository on the unit
of work and raise ``AccountNotFoundError`` (mapped to 404 at the boundary, ADR-111)
when the referenced account is missing or owned by another user. Driven through the
in-memory :class:`FakeUnitOfWork` so they run with no database.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.transaction import CreateTransaction, UpdateTransaction
from margen_api.domain.models.account import build_account
from margen_api.domain.models.exceptions import AccountNotFoundError
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind
from margen_api.service_layer.handlers import create_transaction, update_transaction
from tests.fakes.persistence import FakeUnitOfWork

A_DATE = date(2026, 6, 12)
A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"


def _seed_account(uow: FakeUnitOfWork, *, user_id: str = A_USER) -> UUID:
    """Place a committed account (and its institution) in the unit of work's store."""
    institution = build_institution(
        institution_id=uuid4(),
        name="Galicia",
        type=InstitutionType.BANK,
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_institutions[institution.id] = institution
    account = build_account(
        account_id=uuid4(),
        institution_id=institution.id,
        currency=Currency.ARS,
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_accounts[account.id] = account
    return account.id


def _seed_transaction(uow: FakeUnitOfWork, *, user_id: str = A_USER) -> UUID:
    """Place a committed transaction in the unit of work's store and return its id."""
    transaction = build_transaction(
        transaction_id=uuid4(),
        occurred_on=A_DATE,
        name="Rent",
        kind=Kind.EXPENSE,
        amount=Decimal("1000"),
        user_id=user_id,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    uow.committed_aggregates[transaction.id] = transaction
    return transaction.id


class TestCreateLinksAccount:
    """Creating a transaction with an account link checks ownership (ADR-130)."""

    async def test_links_own_account(self):
        """
        GIVEN an account owned by the caller
        WHEN a transaction is created linking that account
        THEN the transaction is persisted carrying the account_id
        """
        # GIVEN
        uow = FakeUnitOfWork()
        account_id = _seed_account(uow)

        # WHEN
        transaction_id = await create_transaction(
            CreateTransaction(
                occurred_on=A_DATE,
                name="Coto",
                kind=Kind.EXPENSE,
                amount=Decimal("250"),
                user_id=A_USER,
                account_id=account_id,
            ),
            uow,
        )

        # THEN
        assert uow.committed_aggregates[transaction_id].account_id == account_id

    async def test_missing_account_raises_not_found(self):
        """
        GIVEN no account with the referenced id
        WHEN a transaction is created linking it
        THEN AccountNotFoundError is raised and nothing is committed (ADR-130)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await create_transaction(
                CreateTransaction(
                    occurred_on=A_DATE,
                    name="Coto",
                    kind=Kind.EXPENSE,
                    amount=Decimal("250"),
                    user_id=A_USER,
                    account_id=uuid4(),
                ),
                uow,
            )
        assert uow.committed_aggregates == {}

    async def test_foreign_account_is_not_found(self):
        """
        GIVEN an account owned by another user
        WHEN the caller creates a transaction linking it
        THEN AccountNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        foreign_account = _seed_account(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await create_transaction(
                CreateTransaction(
                    occurred_on=A_DATE,
                    name="Coto",
                    kind=Kind.EXPENSE,
                    amount=Decimal("250"),
                    user_id=A_USER,
                    account_id=foreign_account,
                ),
                uow,
            )


class TestUpdateLinksAccount:
    """Patching a transaction's account link checks ownership (ADR-130)."""

    async def test_links_own_account(self):
        """
        GIVEN an existing transaction and an account both owned by the caller
        WHEN the transaction is patched to link the account
        THEN the persisted transaction carries the account_id
        """
        # GIVEN
        uow = FakeUnitOfWork()
        account_id = _seed_account(uow)
        transaction_id = _seed_transaction(uow)

        # WHEN
        await update_transaction(
            UpdateTransaction(id=transaction_id, user_id=A_USER, account_id=account_id),
            uow,
        )

        # THEN
        assert uow.committed_aggregates[transaction_id].account_id == account_id

    async def test_foreign_account_is_not_found(self):
        """
        GIVEN an existing transaction owned by the caller and an account owned by another
        WHEN the caller patches the transaction to link the foreign account
        THEN AccountNotFoundError is raised (ADR-130, ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        foreign_account = _seed_account(uow, user_id=ANOTHER_USER)
        transaction_id = _seed_transaction(uow)

        # WHEN / THEN
        with pytest.raises(AccountNotFoundError):
            await update_transaction(
                UpdateTransaction(id=transaction_id, user_id=A_USER, account_id=foreign_account),
                uow,
            )
