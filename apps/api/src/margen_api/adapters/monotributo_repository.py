"""SQLAlchemy snapshot repository for the Monotributo write side (ADR-052).

The capture handler persists trailing-12-month standings exclusively through this
adapter, on the unit of work — the read endpoint stays read-only. The UPSERT is
keyed by ``period_end`` month so concurrent reads in the same period converge to a
single row. The adapter also exposes the focused read helpers the handler needs to
derive what to persist (the configured category from ``app_settings`` + per-window
included income), so the write path never reaches into the query-side reader. All
I/O is awaited (AGENTS.md).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Kind
from margen_api.service_layer.monotributo_read_models import MonotributoStanding
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository

_ZERO = Decimal(0)
_MONOTRIBUTO_KINDS = (Kind.INVOICE.value, Kind.INCOME.value)
_INCLUDED_AMOUNT = cast(func.sum(TransactionRecord.amount), Numeric(18, 2))


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class SqlAlchemyMonotributoSnapshotRepository(AbstractMonotributoSnapshotRepository):
    """Persist Monotributo standings through an async session (ADR-052)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    async def configured_category(self, user_id: str) -> tuple[str, str] | None:
        """Return the owner's configured ``(category, activity_type)`` from ``app_settings`` (ADR-112).

        The Monotributo category lives in the per-user ``app_settings`` row
        (ADR-054, superseding the retired ``monotributo_config``); scoped to the
        owner (ADR-108) and returning ``None`` when no settings row exists yet so
        the caller supplies a sensible default.
        """
        statement = (
            select(
                AppSettingsRecord.monotributo_current_category,
                AppSettingsRecord.monotributo_activity_type,
            )
            .where(AppSettingsRecord.user_id == UUID(user_id))
            .limit(1)
        )
        row = (await self.session.execute(statement)).first()
        if row is None:
            return None
        return str(row.monotributo_current_category), str(row.monotributo_activity_type)

    async def used_in_window(self, window_start: date, window_end: date, user_id: str) -> Decimal:
        """SUM the owner's included income over the inclusive ``[start, end]`` window (ADR-108)."""
        statement = select(_INCLUDED_AMOUNT).where(
            TransactionRecord.user_id == UUID(user_id),
            TransactionRecord.kind.in_(_MONOTRIBUTO_KINDS),
            TransactionRecord.counts_toward_monotributo.is_(True),
            TransactionRecord.occurred_on >= window_start,
            TransactionRecord.occurred_on <= window_end,
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        return _ZERO if total is None else _as_decimal(total)

    async def existing_period_ends(self, user_id: str) -> set[date]:
        """Return the owner's ``period_end`` months that already have a snapshot (ADR-108)."""
        statement = select(MonotributoSnapshotRecord.period_end).where(
            MonotributoSnapshotRecord.user_id == UUID(user_id)
        )
        result = await self.session.execute(statement)
        return set(result.scalars().all())

    async def upsert(self, standing: MonotributoStanding, user_id: str) -> None:
        """Insert or update the owner's snapshot for the standing's ``period_end`` (ADR-052, ADR-112)."""
        owner = UUID(user_id)
        statement = (
            select(MonotributoSnapshotRecord)
            .where(
                MonotributoSnapshotRecord.user_id == owner,
                MonotributoSnapshotRecord.period_end == standing.period_end,
            )
            .limit(1)
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            self.session.add(_to_record(standing, owner))
            return
        _apply(record, standing)


def _to_record(standing: MonotributoStanding, owner: UUID) -> MonotributoSnapshotRecord:
    """Build a new owner-attributed snapshot record from a computed standing (ADR-112)."""
    record = MonotributoSnapshotRecord(
        user_id=owner,
        period_start=standing.period_start,
        period_end=standing.period_end,
        category=standing.category,
        activity_type=standing.activity_type,
        limit_amount=standing.limit,
        used=standing.used,
        remaining=standing.remaining,
        percent_used=standing.percent_used,
        status=standing.status,
        projected_category=standing.projected_category,
        captured_at=datetime.now(UTC),
    )
    return record


def _apply(record: MonotributoSnapshotRecord, standing: MonotributoStanding) -> None:
    """Overlay a re-computed standing onto an existing snapshot row (idempotent)."""
    record.period_start = standing.period_start
    record.category = standing.category
    record.activity_type = standing.activity_type
    record.limit_amount = standing.limit
    record.used = standing.used
    record.remaining = standing.remaining
    record.percent_used = standing.percent_used
    record.status = standing.status
    record.projected_category = standing.projected_category
    record.captured_at = datetime.now(UTC)
