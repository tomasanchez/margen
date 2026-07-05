"""Mapping between the ``Debt`` aggregate and its SQLAlchemy record (ADR-187, ADR-183).

The domain aggregate stays plain Python while the ``DebtRecord`` holds the relational
shape. This module is the single place that translates between the two, so the
repository never reaches into ORM internals and the domain never learns about SQLAlchemy
(AGENTS.md).
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.debt import DebtRecord
from margen_api.domain.models.debt import Debt
from margen_api.domain.models.value_objects import Currency


def to_domain(record: DebtRecord) -> Debt:
    """Build a domain :class:`Debt` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are already
    valid, so this is a faithful rehydration rather than fresh validation.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Debt`` aggregate.
    """
    return Debt(
        id=record.id,
        name=record.name,
        currency=Currency.parse(record.currency),
        current_balance=record.current_balance,
        monthly_minimum=record.monthly_minimum,
        rate=record.rate,
        user_id=str(record.user_id) if record.user_id is not None else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(debt: Debt) -> DebtRecord:
    """Build a fresh persistence record from a domain :class:`Debt`.

    Used when adding a new aggregate. ``currency`` is stored as its string value since
    the column is a plain string (ADR-027 style).

    Args:
        debt: The aggregate to persist.

    Returns:
        A new, unattached ``DebtRecord`` carrying every field.
    """
    record = DebtRecord()
    update_record(record, debt)
    return record


def update_record(record: DebtRecord, debt: Debt) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row
    (update/persist semantics). ``id`` is set so a detached record carries its identity;
    for an attached row it is already the same value.

    Args:
        record: The relational row to update in place.
        debt: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write path
            threads the authenticated owner (ADR-130), so a missing id is a programming
            error rather than a persistable state.
    """
    record.id = debt.id
    record.name = debt.name
    record.currency = debt.currency.value
    record.current_balance = debt.current_balance
    record.monthly_minimum = debt.monthly_minimum
    record.rate = debt.rate
    if debt.user_id is None:
        msg = "Cannot persist a debt without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(debt.user_id)
    record.created_at = debt.created_at
    record.updated_at = debt.updated_at
