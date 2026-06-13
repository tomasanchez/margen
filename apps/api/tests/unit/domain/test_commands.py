"""Unit tests for the frozen transaction commands (ADR-028).

Commands carry input fields only; identity and timestamps are server-managed.
These check the boundary validation Pydantic enforces and that ``UpdateTransaction``
leaves omitted fields as ``None`` ("leave unchanged").
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.domain.models.value_objects import Currency, Kind

A_DATE = date(2026, 6, 12)


class TestCreateTransactionCommand:
    """Boundary validation for the create command."""

    async def test_minimal_valid_command(self):
        """
        GIVEN the minimal required create fields
        WHEN the command is constructed
        THEN it defaults currency to ARS and the counting hint to False
        """
        # WHEN
        command = CreateTransaction(
            occurred_on=A_DATE,
            name="Coto",
            kind=Kind.EXPENSE,
            amount=Decimal("100"),
        )

        # THEN
        assert command.currency is Currency.ARS
        assert command.counts_toward_monotributo is False

    async def test_non_positive_amount_is_rejected(self):
        """
        GIVEN a create command with a non-positive amount
        WHEN the command is constructed
        THEN Pydantic raises a ValidationError (gt=0)
        """
        # WHEN / THEN
        with pytest.raises(ValidationError):
            CreateTransaction(occurred_on=A_DATE, name="Coto", kind=Kind.EXPENSE, amount=Decimal("0"))

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a create command with an empty name
        WHEN the command is constructed
        THEN Pydantic raises a ValidationError (min_length=1)
        """
        # WHEN / THEN
        with pytest.raises(ValidationError):
            CreateTransaction(occurred_on=A_DATE, name="", kind=Kind.EXPENSE, amount=Decimal("100"))


class TestUpdateTransactionCommand:
    """Boundary validation and patch semantics for the update command."""

    async def test_only_identity_required(self):
        """
        GIVEN an update command with only the identity supplied
        WHEN the command is constructed
        THEN every mutable field defaults to None ("leave unchanged")
        """
        # WHEN
        command = UpdateTransaction(id=uuid4())

        # THEN
        assert command.name is None
        assert command.amount is None
        assert command.kind is None

    async def test_non_positive_amount_is_rejected(self):
        """
        GIVEN an update command with a non-positive amount
        WHEN the command is constructed
        THEN Pydantic raises a ValidationError
        """
        # WHEN / THEN
        with pytest.raises(ValidationError):
            UpdateTransaction(id=uuid4(), amount=Decimal("-5"))


class TestDeleteTransactionCommand:
    """The delete command addresses a single aggregate by identity."""

    async def test_carries_identity(self):
        """
        GIVEN an identity
        WHEN a delete command is constructed
        THEN it carries that identity
        """
        # GIVEN
        identity = uuid4()

        # WHEN
        command = DeleteTransaction(id=identity)

        # THEN
        assert command.id == identity
