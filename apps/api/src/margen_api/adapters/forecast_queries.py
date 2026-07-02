"""SQLAlchemy reader for the cash-flow forecast query side (ADR-176, ADR-177).

Runs read-only queries against an ``AsyncSession`` to derive the committed outflow
streams the pure :mod:`margen_api.service_layer.forecast` engine projects; the horizon
math and no-double-count rule live there, this adapter only does the SQL (AGENTS.md).
Three committed sources feed the forecast (ADR-176, ADR-177):

* **Recurring subscriptions** — flagged recurring expense streams (``recurring=true``).
  Grouped by ``(name, category)``; each stream's LATEST occurrence supplies its amount,
  cadence (monthly / quarterly / annual, defaulting to monthly) and last-actual month.
* **Instalment tails** — expense streams marked ``recurring_cadence='installment'``.
  Grouped by ``(name, category)``; each plan's latest occurrence supplies the cuota
  amount, its ``installments_total`` / ``installments_index`` (remaining =
  ``total - index``) and last-actual month.
* **Monotributo cuota** — the owner's configured category's monthly cuota, an AFIP-ARS
  committed tax outflow in every horizon month (ADR-177).

Denomination follows the reports pattern (ADR-168/152): the ARS path uses the row's
authoritative ``amount``; the USD path uses the ``usd_amount`` snapshot, treating a
null snapshot as an excluded stream (amount ``None``) and counting those exclusions as
``unconverted``. The monotributo cuota is AFIP-ARS and is included at its ARS value on
BOTH paths — it carries no FX snapshot, and re-denominating a tax figure at a live rate
would misrepresent it (ADR-177); it therefore never contributes to ``unconverted``
(it is a known ARS figure, not a missing snapshot). Every query is owner-scoped
(ADR-108, ADR-131). All I/O is awaited.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.forecast import (
    DEFAULT_HORIZON,
    InstallmentStream,
    RecurringStream,
    build_forecast,
    clamp_horizon,
)
from margen_api.service_layer.forecast_read_models import ForecastSeries
from margen_api.service_layer.forecast_reader import AbstractForecastReader
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.summaries import month_key

# The activity-type token that selects the services cuota column; anything else
# (``bienes``) selects the goods column (ADR-046, mirrors monotributo.build_standing).
_SERVICES_ACTIVITY = "services"


class SqlAlchemyForecastReader(AbstractForecastReader):
    """Serve the committed-outflow forecast from server-side SQL (ADR-176, ADR-177).

    Reuses the monotributo repository's ``configured_category`` read helper (ADR-112)
    for the tax cuota so the configured category is read from ``app_settings`` exactly
    as the monotributo standing does, keeping a single source of truth.
    """

    def __init__(self, session: AsyncSession, monotributo: AbstractMonotributoSnapshotRepository) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
            monotributo: The monotributo repository whose ``configured_category`` read
                helper supplies the owner's configured category and activity type.
        """
        self.session = session
        self.monotributo = monotributo

    async def forecast(
        self,
        user_id: str,
        *,
        horizon: int = DEFAULT_HORIZON,
        currency: Currency = Currency.ARS,
    ) -> ForecastSeries:
        """Assemble the owner's committed-outflow cash-flow forecast (ADR-176, ADR-177, ADR-131)."""
        owner = UUID(user_id)
        horizon = clamp_horizon(horizon)
        reference = datetime.now(UTC).date()
        is_usd = currency is Currency.USD

        recurring_streams, recurring_unconverted = await self._recurring_streams(owner, is_usd=is_usd)
        installment_streams, installment_unconverted = await self._installment_streams(owner, is_usd=is_usd)
        monotributo_cuota = await self._monotributo_cuota(user_id)
        unconverted = recurring_unconverted + installment_unconverted if is_usd else 0
        return build_forecast(
            reference,
            horizon,
            currency.value,
            recurring_streams=recurring_streams,
            installment_streams=installment_streams,
            monotributo_cuota=monotributo_cuota,
            unconverted=unconverted,
        )

    async def _latest_expense_rows(
        self,
        owner: UUID,
        *,
        installments: bool,
    ) -> list[TransactionRecord]:
        """Return the owner's committed expense rows for one source, newest-first (ADR-108).

        Fetches the candidate rows for either the recurring-subscription source
        (``recurring=true``) or the instalment source (``recurring_cadence='installment'``),
        ordered by ``(occurred_on DESC, created_at DESC)`` so the FIRST row seen per
        ``(name, category)`` stream is that stream's LATEST actual occurrence — the one
        that supplies the amount, cadence / cuota figures and last-actual month (ADR-176).
        Every row is an EXPENSE scoped to the owner.

        Args:
            owner: The authenticated owner every row is scoped to.
            installments: When ``True`` fetch the instalment source; otherwise the
                flagged-recurring subscription source.

        Returns:
            The candidate expense rows, newest-first.
        """
        if installments:
            source_predicate = TransactionRecord.recurring_cadence == RecurringCadence.INSTALLMENT.value
        else:
            # A subscription stream is a flagged recurring expense whose cadence is a
            # subscription cadence (or unset → monthly). An instalment-marked row is
            # excluded here so a row never counts as both a subscription and a tail.
            source_predicate = and_(
                TransactionRecord.recurring.is_(True),
                or_(
                    TransactionRecord.recurring_cadence.is_(None),
                    TransactionRecord.recurring_cadence != RecurringCadence.INSTALLMENT.value,
                ),
            )
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.kind == Kind.EXPENSE.value,
                source_predicate,
            )
            .order_by(TransactionRecord.occurred_on.desc(), TransactionRecord.created_at.desc())
        )
        result = await self.session.execute(statement)
        return list(result.scalars().all())

    def _denominated_amount(self, record: TransactionRecord, *, is_usd: bool) -> Decimal | None:
        """Return a row's amount in the requested currency, or ``None`` when excluded (ADR-168).

        The ARS path uses the authoritative ``amount``; the USD path uses the
        ``usd_amount`` snapshot and returns ``None`` when the row lacks one, so the
        caller counts it as ``unconverted`` and the stream is dropped from the sums
        (ADR-152).
        """
        if not is_usd:
            return record.amount
        if record.usd_amount is None:
            return None
        return record.usd_amount

    async def _recurring_streams(self, owner: UUID, *, is_usd: bool) -> tuple[list[RecurringStream], int]:
        """Derive the flagged recurring subscription streams and the USD unconverted count (ADR-176).

        Collapses the owner's flagged recurring expense rows to one stream per
        ``(name, category)`` keyed off each stream's LATEST occurrence: its denominated
        amount, its cadence (the latest row's ``recurring_cadence`` or monthly when
        unset) and its last-actual month. On the USD path a stream whose latest row
        lacks a snapshot contributes to the ``unconverted`` count and carries a ``None``
        amount (dropped from the projected sums, ADR-152).
        """
        rows = await self._latest_expense_rows(owner, installments=False)
        streams: list[RecurringStream] = []
        unconverted = 0
        seen: set[tuple[str, str | None]] = set()
        for record in rows:
            key = (record.name, record.category)
            if key in seen:
                continue
            seen.add(key)
            amount = self._denominated_amount(record, is_usd=is_usd)
            if amount is None:
                unconverted += 1
            cadence = RecurringCadence.parse(record.recurring_cadence) or RecurringCadence.MONTHLY
            streams.append(
                RecurringStream(
                    label=record.name,
                    amount=amount,
                    cadence=cadence,
                    last_actual_month=month_key(record.occurred_on),
                )
            )
        return streams, unconverted

    async def _installment_streams(self, owner: UUID, *, is_usd: bool) -> tuple[list[InstallmentStream], int]:
        """Derive the instalment plan tails and the USD unconverted count (ADR-176).

        Collapses the owner's instalment-marked expense rows to one plan per
        ``(name, category)`` keyed off each plan's LATEST occurrence: its cuota amount,
        its remaining payment count (``installments_total - installments_index``,
        floored at ``0``) and its last-actual month. A plan whose latest row carries no
        structured ``installments_total`` / ``installments_index`` yields no remaining
        payments (``0``) and simply produces no tail. On the USD path a plan whose latest
        row lacks a snapshot contributes to ``unconverted`` and carries a ``None`` amount
        (ADR-152).
        """
        rows = await self._latest_expense_rows(owner, installments=True)
        streams: list[InstallmentStream] = []
        unconverted = 0
        seen: set[tuple[str, str | None]] = set()
        for record in rows:
            key = (record.name, record.category)
            if key in seen:
                continue
            seen.add(key)
            amount = self._denominated_amount(record, is_usd=is_usd)
            if amount is None:
                unconverted += 1
            remaining = self._remaining_count(record)
            streams.append(
                InstallmentStream(
                    label=record.name,
                    amount=amount,
                    remaining_count=remaining,
                    last_actual_month=month_key(record.occurred_on),
                )
            )
        return streams, unconverted

    def _remaining_count(self, record: TransactionRecord) -> int:
        """Return an instalment plan's remaining payments from its latest row (ADR-176).

        ``installments_total - installments_index``, floored at ``0``. When either
        figure is missing the plan has no structured tail, so ``0`` is returned and the
        engine projects nothing for it.
        """
        total = record.installments_total
        index = record.installments_index
        if total is None or index is None:
            return 0
        return max(0, total - index)

    async def _monotributo_cuota(self, user_id: str) -> Decimal | None:
        """Return the owner's configured monotributo monthly cuota, or ``None`` (ADR-177).

        Reads the configured ``(category, activity_type)`` from ``app_settings`` via the
        monotributo repository (ADR-112). The monthly cuota is the current scale's cuota
        for that category and activity — the services cuota for a services taxpayer, the
        goods cuota otherwise (ADR-046). Returns ``None`` when the owner has no configured
        category (monotributo not set up), so the forecast simply omits the tax leg. The
        figure is AFIP-ARS and is included at its ARS value regardless of the requested
        display currency (ADR-177).
        """
        configured = await self.monotributo.configured_category(user_id)
        if configured is None:
            return None
        category, activity_type = configured
        try:
            row = get_category(category)
        except KeyError:
            return None
        return row.cuota_servicios if activity_type == _SERVICES_ACTIVITY else row.cuota_bienes
