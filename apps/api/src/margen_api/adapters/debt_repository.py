"""SQLAlchemy repository for the ``Debt`` aggregate (write side) (ADR-187, ADR-130).

The repository is the only place handlers touch persistence for debt writes. It maps
between the aggregate and its ``DebtRecord`` and awaits all I/O against an
``AsyncSession`` so the event loop is never blocked (AGENTS.md). It does not own the
transaction boundary — the unit of work commits. Every lookup is owner-scoped (ADR-130):
a foreign owner's id is treated as absent so the boundary answers 404 (ADR-111).
``user_id`` is the Supabase ``sub`` string, coerced to ``UUID`` at this persistence
boundary (ADR-094).
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.debt import to_domain, to_record, update_record
from margen_api.adapters.models.debt import DebtRecord
from margen_api.domain.models.debt import Debt
from margen_api.service_layer.debt_repository import AbstractDebtRepository


class SqlAlchemyDebtRepository(AbstractDebtRepository):
    """Persist :class:`Debt` aggregates through an async session (ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, debt: Debt) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit.

        Ownership rides on the aggregate: ``to_record`` copies ``debt.user_id`` onto the
        row's ownership column (ADR-094, ADR-130).
        """
        self.session.add(to_record(debt))

    async def get(self, debt_id: UUID, user_id: str) -> Debt | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-130, ADR-111).

        Scopes the lookup by ``user_id`` so a foreign owner's id is not found — the update
        handler maps that to a 404 at the boundary (ADR-111).
        """
        statement = select(DebtRecord).where(
            DebtRecord.id == debt_id,
            DebtRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return to_domain(record)

    async def persist(self, debt: Debt) -> None:
        """Apply a mutated aggregate to its attached row (update semantics).

        The aggregate was loaded through :meth:`get`, which rehydrates ``user_id`` from
        the row, so writing it back via ``update_record`` preserves ownership rather than
        clobbering it (ADR-130).
        """
        record = await self.session.get(DebtRecord, debt.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(debt))
            return
        update_record(record, debt)

    async def delete(self, debt_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's row for ``debt_id`` (ADR-187, ADR-130).

        Scoped to ``user_id``: a row owned by another user is not matched, so the delete
        reports a miss and the boundary answers 404 (ADR-111).
        """
        statement = select(DebtRecord).where(
            DebtRecord.id == debt_id,
            DebtRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True
