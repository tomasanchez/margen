"""SQLAlchemy repository for the ``BudgetIncome`` aggregate (write side) (ADR-139, ADR-130).

The repository is the only place handlers touch persistence for income-base writes.
It maps between the aggregate and its ``BudgetIncomeRecord`` and awaits all I/O
against an ``AsyncSession`` so the event loop is never blocked (AGENTS.md). It does
not own the transaction boundary — the unit of work commits. Every lookup is
owner-scoped (ADR-130). The upsert resolves the natural key ``(user_id, period)`` so
a month never gets a duplicate base (the UNIQUE constraint, ADR-139). ``user_id`` is
the Supabase ``sub`` string, coerced to ``UUID`` at this persistence boundary
(ADR-094). Mirrors ``SqlAlchemyBudgetRepository``.
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.budget_income import to_domain, to_record, update_record
from margen_api.adapters.models.budget_income import BudgetIncomeRecord
from margen_api.domain.models.budget_income import BudgetIncome
from margen_api.service_layer.budget_income_repository import AbstractBudgetIncomeRepository


class SqlAlchemyBudgetIncomeRepository(AbstractBudgetIncomeRepository):
    """Persist :class:`BudgetIncome` aggregates through an async session (ADR-139, ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, income: BudgetIncome) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit (ADR-130)."""
        self.session.add(to_record(income))

    async def get_by_period(self, period: date, user_id: str) -> BudgetIncome | None:
        """Load the owner's income base for a month, or ``None`` (ADR-139, ADR-130)."""
        statement = select(BudgetIncomeRecord).where(
            BudgetIncomeRecord.user_id == UUID(user_id),
            BudgetIncomeRecord.period == period,
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return to_domain(record)

    async def persist(self, income: BudgetIncome) -> None:
        """Apply a mutated aggregate to its attached row (update semantics)."""
        record = await self.session.get(BudgetIncomeRecord, income.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(income))
            return
        update_record(record, income)
