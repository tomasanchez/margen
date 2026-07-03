"""SQLAlchemy reader for the committed-spend accent query side (ADR-179).

Runs read-only queries against an ``AsyncSession`` to derive the committed streams the
pure :mod:`margen_api.service_layer.committed` engine splits into paid vs pending for a
TARGET month; the offset-0 no-double-count rule lives there, this adapter only does the
SQL (AGENTS.md). The committed universe mirrors the forecast (ADR-176, ADR-177):

* **Recurring subscriptions** — flagged recurring expense streams (``recurring=true``,
  cadence not ``installment``). Grouped by ``(name, category)``; each stream's LATEST
  occurrence supplies its cadence and last-actual month, and this-month rows supply its
  posted amount.
* **Instalment cuotas** — expense streams marked ``recurring_cadence='installment'``.
  Grouped by ``(name, category)``; each plan's latest occurrence supplies its remaining
  count and last-actual month, and this-month rows supply its posted amount.
* **Monotributo cuota** — the owner's configured category's monthly cuota, an AFIP-ARS
  committed tax outflow (ADR-177). Posted when a monotributo-category expense landed this
  month; otherwise pending in the ARS denomination.

For each stream the adapter derives, for the target month, the already-POSTED amount (the
committed rows that landed this month) and the EXPECTED-this-month amount (the stream's
cadence/tail evaluated at offset 0), both denominated per the reports pattern
(ADR-168/152): the ARS path uses the row's authoritative ``amount``; the USD path uses
the ``usd_amount`` snapshot, treating a null snapshot as an excluded stream and counting
it as ``unconverted``. The monotributo cuota is AFIP-ARS on both paths and never counts
as ``unconverted`` (ADR-177). Every query is owner-scoped (ADR-108, ADR-131). All I/O is
awaited.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.committed import CommittedStream, build_committed
from margen_api.service_layer.committed_read_models import CommittedSplit
from margen_api.service_layer.committed_reader import AbstractCommittedReader
from margen_api.service_layer.forecast_read_models import CommitmentSource
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.summaries import add_months, month_key

# The activity-type token that selects the services cuota column; anything else
# (``bienes``) selects the goods column (ADR-046, mirrors the forecast reader).
_SERVICES_ACTIVITY = "services"

# The category a monotributo cuota outflow is recorded under (KNOWN_CATEGORIES, ADR-027);
# the only structured tax signal, since expenses cannot carry counts_toward_monotributo.
_TAXES_CATEGORY = "Taxes"

# The cadence period in calendar months for the subscription-style cadences; an
# ``installment`` is due each month of its tail (handled separately, ADR-176).
_CADENCE_MONTHS: dict[RecurringCadence, int] = {
    RecurringCadence.MONTHLY: 1,
    RecurringCadence.QUARTERLY: 3,
    RecurringCadence.ANNUAL: 12,
}


def _month_offset(from_key: str, to_key: str) -> int:
    """Return the signed number of calendar months from ``from_key`` to ``to_key`` (ADR-176)."""
    from_year, from_month = (int(part) for part in from_key.split("-"))
    to_year, to_month = (int(part) for part in to_key.split("-"))
    return (to_year * 12 + (to_month - 1)) - (from_year * 12 + (from_month - 1))


class SqlAlchemyCommittedReader(AbstractCommittedReader):
    """Serve the committed-spend paid/pending split from server-side SQL (ADR-179).

    Reuses the monotributo repository's ``configured_category`` read helper (ADR-112)
    for the tax cuota so the configured category is read from ``app_settings`` exactly
    as the forecast and monotributo standing do, keeping a single source of truth.
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

    async def committed(
        self,
        month: date,
        user_id: str,
        *,
        currency: Currency = Currency.ARS,
    ) -> CommittedSplit:
        """Assemble the owner's committed paid/pending split for a month (ADR-179, ADR-131)."""
        owner = UUID(user_id)
        is_usd = currency is Currency.USD
        target = month_key(month)

        subscription_streams, subscription_unconverted = await self._subscription_streams(
            owner, target=target, is_usd=is_usd
        )
        installment_streams, installment_unconverted = await self._installment_streams(
            owner, target=target, is_usd=is_usd
        )
        tax_stream = await self._tax_stream(user_id, owner, month=month, target=target)

        streams = subscription_streams + installment_streams
        if tax_stream is not None:
            streams.append(tax_stream)
        unconverted = subscription_unconverted + installment_unconverted if is_usd else 0
        return build_committed(target, currency.value, streams=streams, unconverted=unconverted)

    async def _committed_expense_rows(self, owner: UUID, *, installments: bool) -> list[TransactionRecord]:
        """Return the owner's committed expense rows for one source, newest-first (ADR-108).

        Mirrors the forecast reader: fetches either the recurring-subscription source
        (``recurring=true``, cadence not ``installment``) or the instalment source
        (``recurring_cadence='installment'``), ordered ``(occurred_on DESC, created_at
        DESC)`` so the FIRST row seen per ``(name, category)`` stream is its LATEST actual
        occurrence. Every row is an EXPENSE scoped to the owner.
        """
        if installments:
            source_predicate = TransactionRecord.recurring_cadence == RecurringCadence.INSTALLMENT.value
        else:
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
        ``usd_amount`` snapshot and returns ``None`` when the row lacks one (ADR-152).
        """
        if not is_usd:
            return record.amount
        return record.usd_amount

    async def _subscription_streams(
        self,
        owner: UUID,
        *,
        target: str,
        is_usd: bool,
    ) -> tuple[list[CommittedStream], int]:
        """Derive the subscription streams' paid/pending figures for the target month (ADR-179).

        Collapses the owner's flagged recurring rows to one stream per ``(name,
        category)`` keyed off its LATEST occurrence (cadence, last-actual month, expected
        amount). The posted amount is the SUM of the stream's rows dated in the target
        month; the expected amount applies only when the stream's cadence lands the target
        month strictly after its latest actual (offset 0 rule, ADR-176). On the USD path a
        stream whose latest row lacks a snapshot contributes to ``unconverted``.
        """
        rows = await self._committed_expense_rows(owner, installments=False)
        streams: list[CommittedStream] = []
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
            posted = self._posted_this_month(rows, key, target=target, is_usd=is_usd)
            expected = self._subscription_expected(record, amount, cadence=cadence, target=target)
            streams.append(CommittedStream(source=CommitmentSource.SUBSCRIPTION, posted=posted, expected=expected))
        return streams, unconverted

    async def _installment_streams(
        self,
        owner: UUID,
        *,
        target: str,
        is_usd: bool,
    ) -> tuple[list[CommittedStream], int]:
        """Derive the instalment plans' paid/pending figures for the target month (ADR-179).

        Collapses the owner's instalment rows to one plan per ``(name, category)`` keyed
        off its LATEST occurrence. The posted amount is the SUM of the plan's cuotas dated
        in the target month; the expected amount applies only when the plan still has a
        remaining cuota AND its latest actual is a prior month (its tail reaches the target
        month, offset 0 rule, ADR-176). On the USD path a plan whose latest row lacks a
        snapshot contributes to ``unconverted``.
        """
        rows = await self._committed_expense_rows(owner, installments=True)
        streams: list[CommittedStream] = []
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
            posted = self._posted_this_month(rows, key, target=target, is_usd=is_usd)
            expected = self._installment_expected(record, amount, target=target)
            streams.append(CommittedStream(source=CommitmentSource.INSTALLMENT, posted=posted, expected=expected))
        return streams, unconverted

    def _posted_this_month(
        self,
        rows: list[TransactionRecord],
        key: tuple[str, str | None],
        *,
        target: str,
        is_usd: bool,
    ) -> Decimal | None:
        """SUM a stream's committed rows dated in the target month, or ``None`` (ADR-179).

        A stream is PAID this month when at least one of its rows is dated in the target
        month (already inside the month's Expenses total). Returns the summed denominated
        amount, or ``None`` when the stream did not post this month (or, on the USD path,
        the posted rows carry no snapshot — the amount cannot be denominated).
        """
        posted = Decimal(0)
        found = False
        for record in rows:
            if (record.name, record.category) != key or month_key(record.occurred_on) != target:
                continue
            amount = self._denominated_amount(record, is_usd=is_usd)
            if amount is None:
                continue
            posted += amount
            found = True
        return posted if found else None

    def _subscription_expected(
        self,
        record: TransactionRecord,
        amount: Decimal | None,
        *,
        cadence: RecurringCadence,
        target: str,
    ) -> Decimal | None:
        """Return a subscription's expected-this-month amount, or ``None`` (ADR-176/179).

        The stream is due the target month when the offset from its latest actual to the
        target is a POSITIVE multiple of its cadence period — strictly after the latest
        actual (offset 0 rule). A same-or-future latest actual (offset ``<= 0``) means the
        actual owns the target month, so nothing is expected on top of it.
        """
        if amount is None:
            return None
        period = _CADENCE_MONTHS[cadence]
        offset = _month_offset(month_key(record.occurred_on), target)
        if offset > 0 and offset % period == 0:
            return amount
        return None

    def _installment_expected(
        self,
        record: TransactionRecord,
        amount: Decimal | None,
        *,
        target: str,
    ) -> Decimal | None:
        """Return an instalment plan's expected-this-month cuota, or ``None`` (ADR-176/179).

        A remaining cuota lands the target month when the target is within the tail —
        offset ``1..remaining_count`` months after the latest actual (offset 0 rule). A
        plan with no remaining cuota, or whose latest actual is at/after the target,
        expects nothing.
        """
        if amount is None:
            return None
        remaining = self._remaining_count(record)
        if remaining <= 0:
            return None
        offset = _month_offset(month_key(record.occurred_on), target)
        if 1 <= offset <= remaining:
            return amount
        return None

    def _remaining_count(self, record: TransactionRecord) -> int:
        """Return an instalment plan's remaining payments from its latest row (ADR-176).

        ``installments_total - installments_index``, floored at ``0``; ``0`` when either
        figure is missing (no structured tail).
        """
        total = record.installments_total
        index = record.installments_index
        if total is None or index is None:
            return 0
        return max(0, total - index)

    async def _tax_stream(
        self,
        user_id: str,
        owner: UUID,
        *,
        month: date,
        target: str,
    ) -> CommittedStream | None:
        """Derive the monotributo cuota's paid/pending figure for the target month (ADR-177/179).

        Returns ``None`` when the owner has no configured category (the tax leg is
        omitted). Otherwise the AFIP-ARS cuota is PAID when a monotributo-category expense
        landed this month, else PENDING — the cuota is a monthly committed outflow, so it
        is always due the target month. The cuota is AFIP-ARS and ``ars_fixed`` so the
        engine sums it only on an ARS request (ADR-177).
        """
        cuota = await self._monotributo_cuota(user_id)
        if cuota is None or cuota <= Decimal(0):
            return None
        posted = await self._tax_posted_this_month(owner, month=month)
        if posted:
            return CommittedStream(source=CommitmentSource.TAX, posted=cuota, expected=None, ars_fixed=True)
        return CommittedStream(source=CommitmentSource.TAX, posted=None, expected=cuota, ars_fixed=True)

    async def _tax_posted_this_month(self, owner: UUID, *, month: date) -> bool:
        """Return whether a tax (AFIP) expense landed in the target month (ADR-177, ADR-179).

        The cuota flips to paid once its AFIP outflow posts. A monotributo cuota is recorded
        in the ledger as an EXPENSE in the ``Taxes`` category (the only structured tax signal
        available — the ``counts_toward_monotributo`` flag is meaningful only for income /
        invoice, so an expense cannot carry it, ADR-158). When such a ``Taxes`` expense is
        dated in the target month the cuota is treated as paid rather than still pending;
        otherwise the known AFIP-ARS cuota remains pending.
        """
        upper = add_months(date(month.year, month.month, 1), 1)
        statement = select(TransactionRecord.id).where(
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.EXPENSE.value,
            TransactionRecord.category == _TAXES_CATEGORY,
            TransactionRecord.occurred_on >= date(month.year, month.month, 1),
            TransactionRecord.occurred_on < upper,
        )
        result = await self.session.execute(statement.limit(1))
        return result.scalar_one_or_none() is not None

    async def _monotributo_cuota(self, user_id: str) -> Decimal | None:
        """Return the owner's configured monotributo monthly cuota, or ``None`` (ADR-177).

        Mirrors the forecast reader: reads the configured ``(category, activity_type)``
        from ``app_settings`` via the monotributo repository (ADR-112) and returns the
        current scale's services or goods cuota (ADR-046). Returns ``None`` when the owner
        has no configured category.
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
