"""Mapping between the ``BudgetIncome`` aggregate and its SQLAlchemy record (ADR-139).

The domain aggregate stays plain Python while the ``BudgetIncomeRecord`` holds the
relational shape. This module is the single place that translates between the two,
so the repository never reaches into ORM internals and the domain never learns about
SQLAlchemy (AGENTS.md). Mirrors ``adapters.mappers.budget``.
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.budget_income import BudgetIncomeRecord
from margen_api.domain.models.budget_income import BudgetIncome
from margen_api.domain.models.value_objects import Currency


def to_domain(record: BudgetIncomeRecord) -> BudgetIncome:
    """Build a domain :class:`BudgetIncome` from a persisted record.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``BudgetIncome`` aggregate.
    """
    return BudgetIncome(
        id=record.id,
        user_id=str(record.user_id) if record.user_id is not None else None,
        period=record.period,
        amount=record.amount,
        currency=Currency.parse(record.currency),
        source=record.source,
        floor_amount=record.floor_amount,
        floor_source=record.floor_source,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(income: BudgetIncome) -> BudgetIncomeRecord:
    """Build a fresh persistence record from a domain :class:`BudgetIncome`.

    Args:
        income: The aggregate to persist.

    Returns:
        A new, unattached ``BudgetIncomeRecord`` carrying every field.
    """
    record = BudgetIncomeRecord()
    update_record(record, income)
    return record


def update_record(record: BudgetIncomeRecord, income: BudgetIncome) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Args:
        record: The relational row to update in place.
        income: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write
            path threads the authenticated owner (ADR-130), so a missing id is a
            programming error rather than a persistable state.
    """
    record.id = income.id
    record.period = income.period
    record.amount = income.amount
    record.currency = income.currency.value
    record.source = income.source
    record.floor_amount = income.floor_amount
    record.floor_source = income.floor_source
    if income.user_id is None:
        msg = "Cannot persist a budget income without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(income.user_id)
    record.created_at = income.created_at
    record.updated_at = income.updated_at
