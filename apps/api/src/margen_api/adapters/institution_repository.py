"""SQLAlchemy repository for the ``Institution`` aggregate (write side) (ADR-130, ADR-134).

The repository is the only place handlers touch persistence for institution
writes. It maps between the aggregate and its ``InstitutionRecord`` and awaits all
I/O against an ``AsyncSession`` so the event loop is never blocked (AGENTS.md). It
does not own the transaction boundary — the unit of work commits. Every lookup is
owner-scoped (ADR-130): a foreign owner's id is treated as absent so the boundary
answers 404 (ADR-111). ``user_id`` is the Supabase ``sub`` string, coerced to
``UUID`` at this persistence boundary (ADR-094).
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.mappers.institution import to_domain, to_record, update_record
from margen_api.adapters.models.institution import InstitutionRecord
from margen_api.domain.models.institution import Institution
from margen_api.service_layer.institution_repository import AbstractInstitutionRepository


class SqlAlchemyInstitutionRepository(AbstractInstitutionRepository):
    """Persist :class:`Institution` aggregates through an async session (ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add(self, institution: Institution) -> None:
        """Stage a new aggregate; the unit of work flushes it on commit.

        Ownership rides on the aggregate: ``to_record`` copies ``institution.user_id``
        onto the row's ownership column (ADR-094, ADR-130).
        """
        self.session.add(to_record(institution))

    async def get(self, institution_id: UUID, user_id: str) -> Institution | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-130, ADR-111).

        Scopes the lookup by ``user_id`` so a foreign owner's id is not found — the
        update handler maps that to a 404 at the boundary (ADR-111).
        """
        statement = select(InstitutionRecord).where(
            InstitutionRecord.id == institution_id,
            InstitutionRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return to_domain(record)

    async def persist(self, institution: Institution) -> None:
        """Apply a mutated aggregate to its attached row (update semantics).

        The aggregate was loaded through :meth:`get`, which rehydrates ``user_id``
        from the row, so writing it back via ``update_record`` preserves ownership
        rather than clobbering it (ADR-130).
        """
        record = await self.session.get(InstitutionRecord, institution.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(to_record(institution))
            return
        update_record(record, institution)

    async def owns(self, institution_id: UUID, user_id: str) -> bool:
        """Return whether the owner has an institution with ``institution_id`` (ADR-130).

        Used by the account create/update handlers to verify a linked institution
        belongs to the caller before persisting. A missing institution or one owned
        by another user both return ``False``.
        """
        statement = select(InstitutionRecord.id).where(
            InstitutionRecord.id == institution_id,
            InstitutionRecord.user_id == UUID(user_id),
        )
        return (await self.session.execute(statement)).scalar_one_or_none() is not None
