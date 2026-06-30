"""Mapping between the ``Budget`` aggregate and its SQLAlchemy record (ADR-125).

The domain aggregate stays plain Python while the ``BudgetRecord`` holds the
relational shape. This module is the single place that translates between the two,
so the repository never reaches into ORM internals and the domain never learns
about SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.budget import BudgetRecord
from margen_api.domain.models.budget import Budget
from margen_api.domain.models.value_objects import BudgetKind, Currency


def to_domain(record: BudgetRecord) -> Budget:
    """Build a domain :class:`Budget` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are
    already valid, so this is a faithful rehydration rather than fresh validation.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Budget`` aggregate.
    """
    return Budget(
        id=record.id,
        user_id=str(record.user_id) if record.user_id is not None else None,
        category=record.category,
        period=record.period,
        amount=record.amount,
        currency=Currency.parse(record.currency),
        kind=BudgetKind.parse(record.kind),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(budget: Budget) -> BudgetRecord:
    """Build a fresh persistence record from a domain :class:`Budget`.

    Used when adding a new aggregate. ``currency`` is stored as its string value
    since the column is a plain string (ADR-027 style).

    Args:
        budget: The aggregate to persist.

    Returns:
        A new, unattached ``BudgetRecord`` carrying every field.
    """
    record = BudgetRecord()
    update_record(record, budget)
    return record


def update_record(record: BudgetRecord, budget: Budget) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row
    (update/persist semantics). ``id`` is set so a detached record carries its
    identity; for an attached row it is already the same value.

    Args:
        record: The relational row to update in place.
        budget: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write
            path threads the authenticated owner (ADR-130), so a missing id is a
            programming error rather than a persistable state.
    """
    record.id = budget.id
    record.category = budget.category
    record.period = budget.period
    record.amount = budget.amount
    record.currency = budget.currency.value
    record.kind = budget.kind.value
    if budget.user_id is None:
        msg = "Cannot persist a budget without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(budget.user_id)
    record.created_at = budget.created_at
    record.updated_at = budget.updated_at
