"""SQLAlchemy repository for the ``Budget`` aggregate (write side) (ADR-125, ADR-130).

The repository is the only place handlers touch persistence for budget writes. It
maps between the aggregate and its ``BudgetRecord`` and awaits all I/O against an
``AsyncSession`` so the event loop is never blocked (AGENTS.md). It does not own the
transaction boundary — the unit of work commits. Every lookup is owner-scoped
(ADR-130): a foreign owner's row is treated as absent so the boundary answers 404
(ADR-111). The upsert resolves the natural key ``(user_id, category, period)`` so a
category never gets a duplicate target for a month (the UNIQUE constraint, ADR-125).
``user_id`` is the Supabase ``sub`` string, coerced to ``UUID`` at this persistence
boundary (ADR-094).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.budget import to_domain, to_record, update_record
from margen_api.adapters.models.budget import BudgetRecord
from margen_api.domain.models.budget import Budget
from margen_api.domain.models.value_objects import BudgetKind
from margen_api.service_layer.budget_repository import AbstractBudgetRepository


class SqlAlchemyBudgetRepository(AbstractBudgetRepository):
    """Persist :class:`Budget` aggregates through an async session (ADR-125, ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, budget: Budget) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit.

        Ownership rides on the aggregate: ``to_record`` copies ``budget.user_id``
        onto the row's ownership column (ADR-094, ADR-130).
        """
        self.session.add(to_record(budget))

    async def get_by_category_period(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> Budget | None:
        """Load the owner's row for a kind/category/month, or ``None`` (ADR-138, ADR-130).

        Scopes the lookup by ``user_id`` and ``kind`` so a foreign owner's row — or a
        row of the other kind — is not found. The upsert handler uses this to decide
        insert vs replace on the widened key (ADR-138).
        """
        statement = select(BudgetRecord).where(
            BudgetRecord.user_id == UUID(user_id),
            BudgetRecord.kind == kind.value,
            BudgetRecord.category == category,
            BudgetRecord.period == period,
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return to_domain(record)

    async def list_by_period(
        self,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> Sequence[Budget]:
        """List the owner's rows of a kind for a month (ADR-137, ADR-130)."""
        statement = select(BudgetRecord).where(
            BudgetRecord.user_id == UUID(user_id),
            BudgetRecord.kind == kind.value,
            BudgetRecord.period == period,
        )
        result = await self.session.execute(statement)
        return [to_domain(record) for record in result.scalars().all()]

    async def persist(self, budget: Budget) -> None:
        """Apply a mutated aggregate to its attached row (update semantics).

        The aggregate was loaded through :meth:`get_by_category_period`, which
        rehydrates ``user_id`` from the row, so writing it back via ``update_record``
        preserves ownership rather than clobbering it (ADR-130).
        """
        record = await self.session.get(BudgetRecord, budget.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(budget))
            return
        update_record(record, budget)

    async def delete(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> bool:
        """Hard-delete the owner's row for a kind/category/month (ADR-138, ADR-130).

        Scoped to ``user_id`` and ``kind`` so a foreign owner's row — or a row of the
        other kind — is never removed. Returns whether a row was deleted so the
        handler can stay idempotent (ADR-125). Fetches then deletes the attached row
        (mirroring the transfer/transaction repositories) so the cascade and ORM
        state stay consistent.
        """
        statement = select(BudgetRecord).where(
            BudgetRecord.user_id == UUID(user_id),
            BudgetRecord.kind == kind.value,
            BudgetRecord.category == category,
            BudgetRecord.period == period,
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True
