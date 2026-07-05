"""Frozen Pydantic commands for the debt aggregate (ADR-187, ADR-130).

Commands are immutable, boundary-agnostic requests to change state. They carry input
fields only: ``id``, ``created_at`` and ``updated_at`` are server-managed and generated
by the handler, never supplied by the caller. Money is ``Decimal`` (ADR-025);
``currency`` reuses the domain value object so the contract stays aligned with the
aggregate. ``user_id`` is the authenticated owner the entrypoint stamps before dispatch
so every debt is owned from creation (ADR-130).
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.messages import Command
from margen_api.domain.models.value_objects import Currency


class CreateDebt(Command):
    """Request to create a new manual debt (ADR-187, ADR-130).

    The handler generates ``id``, ``created_at`` and ``updated_at`` and applies domain
    invariants via the aggregate (non-empty name, non-negative balance, known currency).
    ``monthlyMinimum`` and ``rate`` are optional YAGNI extension points (ADR-187).
    """

    user_id: str
    name: str = Field(min_length=1)
    currency: Currency = Currency.ARS
    current_balance: Decimal = Field(default=Decimal(0), ge=Decimal(0))
    monthly_minimum: Decimal | None = None
    rate: Decimal | None = None


class UpdateDebt(Command):
    """Request to patch an existing debt (ADR-187, ADR-130).

    Every mutable field is optional; ``None`` means "leave unchanged". The handler loads
    the aggregate by ``id`` **scoped to ``user_id``** (a foreign owner's id is not found,
    ADR-111), applies the present fields, re-runs invariants, and refreshes
    ``updated_at``. ``user_id`` is the authenticated owner the entrypoint sets before
    dispatch; ownership is never patchable.
    """

    id: UUID
    user_id: str
    name: str | None = Field(default=None, min_length=1)
    currency: Currency | None = None
    current_balance: Decimal | None = Field(default=None, ge=Decimal(0))
    monthly_minimum: Decimal | None = None
    rate: Decimal | None = None


class DeleteDebt(Command):
    """Request to delete a debt by identity (ADR-187, ADR-130).

    ``user_id`` is the authenticated owner the entrypoint sets before dispatch; the
    handler scopes the delete by it so a cross-tenant delete removes nothing and surfaces
    a not-found (404, ADR-111).
    """

    id: UUID
    user_id: str
