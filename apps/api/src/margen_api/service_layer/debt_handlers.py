"""Application handlers for the debt aggregate (ADR-187, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the domain
so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain; handlers
contain no SQLAlchemy and no validation of their own (AGENTS.md). Every write is
owner-scoped (ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.debt import CreateDebt, DeleteDebt, UpdateDebt
from margen_api.domain.models.debt import Debt, build_debt
from margen_api.domain.models.exceptions import DebtNotFoundError
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Mutable fields a patch may carry; ``None`` in the command means "leave unchanged"
# (ADR-028). Identity, ownership and ``created_at`` are never patched.
_PATCHABLE_FIELDS = ("name", "currency", "current_balance", "monthly_minimum", "rate")


async def create_debt(command: CreateDebt, uow: AbstractUnitOfWork) -> UUID:
    """Create a new debt owned by the caller and return its identity (ADR-187, ADR-130).

    The handler injects the UUID identity and ``created_at``/``updated_at`` timestamps so
    the domain stays clock- and UUID-free in production (ADR-026), then builds the
    aggregate through the domain factory so invariants run (non-empty name, non-negative
    balance, ADR-031). The debt is stamped with ``command.user_id`` so it is owned from
    creation (ADR-130).

    Args:
        command: The validated create request.
        uow: The unit of work providing the debt repository.

    Returns:
        The UUID identity of the newly persisted debt.
    """
    now = datetime.now(UTC)
    debt = build_debt(
        debt_id=uuid4(),
        created_at=now,
        updated_at=now,
        name=command.name,
        currency=command.currency,
        current_balance=command.current_balance,
        monthly_minimum=command.monthly_minimum,
        rate=command.rate,
        user_id=command.user_id,
    )
    async with uow:
        uow.debts.add(debt)
        await uow.commit()
    return debt.id


async def update_debt(command: UpdateDebt, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to one of the caller's debts (ADR-187, ADR-130).

    Loads the aggregate by identity scoped to ``user_id`` (a foreign owner's id is not
    found, ADR-111), overlays the present fields (``None`` leaves a field unchanged),
    rebuilds it through the domain so invariants re-run (ADR-031), preserves ``id``,
    ``created_at`` and ownership, and refreshes ``updated_at``.

    Args:
        command: The validated patch request, addressing one aggregate by ``id``.
        uow: The unit of work providing the debt repository.

    Returns:
        The UUID identity of the updated debt.

    Raises:
        DebtNotFoundError: When no debt matches ``command.id`` for the owner.
    """
    async with uow:
        existing = await uow.debts.get(command.id, command.user_id)
        if existing is None:
            raise DebtNotFoundError(command.id)
        patched = _apply_patch(existing, command)
        await uow.debts.persist(patched)
        await uow.commit()
    return patched.id


async def delete_debt(command: DeleteDebt, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a debt by identity (ADR-187, ADR-130).

    Scoped to ``command.user_id`` so a cross-tenant delete removes nothing and the
    boundary answers 404 (ADR-111).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the debt repository.

    Raises:
        DebtNotFoundError: When no debt matches ``command.id`` for the owner.
    """
    async with uow:
        removed = await uow.debts.delete(command.id, command.user_id)
        if not removed:
            raise DebtNotFoundError(command.id)
        await uow.commit()


def _apply_patch(existing: Debt, command: UpdateDebt) -> Debt:
    """Build a new aggregate overlaying the patch's present fields (ADR-187).

    Rebuilding through :func:`build_debt` re-runs the domain invariants so the patched
    state is validated and normalized, while preserving identity, ``created_at`` and
    ownership (``user_id``) and bumping ``updated_at`` to now (ADR-026, ADR-031, ADR-130).
    Ownership is never patchable.
    """
    fields = {name: getattr(existing, name) for name in _PATCHABLE_FIELDS}
    for name in _PATCHABLE_FIELDS:
        value = getattr(command, name)
        if value is not None:
            fields[name] = value
    return build_debt(
        debt_id=existing.id,
        created_at=existing.created_at,
        updated_at=datetime.now(UTC),
        user_id=existing.user_id,
        **fields,
    )
