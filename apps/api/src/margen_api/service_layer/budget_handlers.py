"""Application handlers for the budget aggregate (ADR-125, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain;
handlers contain no SQLAlchemy and no validation of their own (AGENTS.md). Every
write is owner-scoped (ADR-130). The upsert resolves an existing target by
``(category, period)`` for the owner so a category never gets a duplicate target for
a month (the UNIQUE constraint, ADR-125).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.budget import ClearBudget, UpsertBudget
from margen_api.domain.models.budget import Budget, build_budget, month_start
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork


async def upsert_budget(command: UpsertBudget, uow: AbstractUnitOfWork) -> UUID:
    """Set or replace a category's monthly target for the caller (ADR-125, ADR-130).

    Resolves any existing target for ``(user_id, category, period)`` scoped to the
    owner (ADR-130). When one exists its amount/currency are replaced in place
    (preserving identity, ``created_at`` and ownership, bumping ``updated_at``) so
    the UNIQUE constraint is never violated; otherwise a fresh target is inserted
    with a generated id and timestamps (ADR-026). Invariants run via the domain
    factory (known currency, period normalized to the first of the month, ADR-031).

    Args:
        command: The validated upsert request, stamped with the authenticated owner.
        uow: The unit of work providing the budget repository.

    Returns:
        The UUID identity of the inserted or replaced target.

    Raises:
        UnknownCurrencyError: When ``command.currency`` is not a known currency
            (mapped to 422 at the boundary, ADR-031).
    """
    period = month_start(command.period)
    async with uow:
        existing = await uow.budgets.get_by_category_period(command.category, period, command.user_id)
        budget = _build_upserted(command, existing, period)
        if existing is None:
            uow.budgets.add(budget)
        else:
            await uow.budgets.persist(budget)
        await uow.commit()
    return budget.id


def _build_upserted(command: UpsertBudget, existing: Budget | None, period: date) -> Budget:
    """Build the target to persist: a fresh insert or the replaced existing row.

    A replace preserves identity, ``created_at`` and ownership and bumps
    ``updated_at`` to now; an insert generates them (ADR-026, ADR-130). Both run the
    domain invariants via :func:`build_budget`.
    """
    now = datetime.now(UTC)
    return build_budget(
        budget_id=existing.id if existing is not None else uuid4(),
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
        user_id=command.user_id,
        category=command.category,
        period=period,
        amount=command.amount,
        currency=command.currency,
    )


async def clear_budget(command: ClearBudget, uow: AbstractUnitOfWork) -> bool:
    """Clear a category's target for a month for the caller (ADR-125, ADR-130).

    Deletes the owner's target for ``(category, period)`` scoped to ``user_id``
    (ADR-130). Idempotent: clearing an absent target is a no-op that reports a miss,
    so the boundary answers ``204`` either way (ADR-125).

    Args:
        command: The validated clear request, stamped with the authenticated owner.
        uow: The unit of work providing the budget repository.

    Returns:
        ``True`` when a target was removed, ``False`` when none existed.
    """
    period = month_start(command.period)
    async with uow:
        removed = await uow.budgets.delete(command.category, period, command.user_id)
        await uow.commit()
    return removed
