"""SQLAlchemy reader for the committed-spend accent query side (ADR-179).

Runs read-only queries against an ``AsyncSession`` to derive the committed streams the
pure :mod:`margen_api.service_layer.committed` engine splits into paid vs pending for a
TARGET month; the offset-0 no-double-count rule lives there, this adapter only does the
SQL (AGENTS.md). The committed universe mirrors the forecast (ADR-176, ADR-177):

* **Recurring subscriptions** — expense streams carrying a non-installment
  ``recurring_cadence`` (ADR-199; the legacy ``recurring`` boolean is no longer read).
  Grouped by ``(name, category)``; each stream's LATEST occurrence supplies its cadence
  and last-actual month, and this-month rows supply its posted amount.
* **Instalment cuotas** — expense streams marked ``recurring_cadence='installment'``.
  Grouped by ``(name, category)``; each plan's latest occurrence supplies its remaining
  count and last-actual month, and this-month rows supply its posted amount.
* **Monotributo cuota** — the owner's configured category's monthly cuota, an AFIP-ARS
  committed tax outflow (ADR-177). PAID at the ACTUAL summed amount of the ``Taxes``-category
  expenses that landed this month (the real spend already in the Expenses total, ADR-179);
  when none posted, PENDING at the monotributo SCALE cuota in the ARS denomination.

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

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, func, select
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

_ZERO = Decimal(0)

# Relative tolerance for the loose "paid this month" fallback (ADR-199): a this-month
# expense in the SAME category whose denominated amount is within ±15% of a stream's
# expected amount fulfils that stream, even when the merchant name was renamed or the
# charge was imported untagged (ADR-198). The exact ``(name, category)`` match is still
# tried first; this is only the fallback.
_PAID_MATCH_TOLERANCE = Decimal("0.15")

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


@dataclass(frozen=True, slots=True)
class _PoolCharge:
    """One this-month expense available to fulfil a committed stream via the loose fallback (ADR-199).

    Attributes:
        name: The charge's merchant name; used to drop the charges an EXACT-match stream
            already consumed so the loose fallback never reuses them (no double-count).
        category: The charge's category; a stream matches only within its own category.
        amount: The charge's denominated amount (per the requested currency, ADR-168).
    """

    name: str
    category: str | None
    amount: Decimal


@dataclass(frozen=True, slots=True)
class _StreamCandidate:
    """A committed stream's target-month figures before the loose paid fallback runs (ADR-199).

    The adapter derives one per subscription / instalment stream. ``exact_posted`` is the
    exact ``(name, category)`` this-month SUM (the ADR-179 first pass); when it is ``None``
    the greedy fallback may still fulfil the stream from a same-category pool charge within
    tolerance of ``expected``.

    Attributes:
        source: Whether the stream is a subscription or an instalment cuota.
        name: The stream's merchant name (its exact-match key with ``category``).
        category: The stream's category, used to scope the loose fallback match.
        exact_posted: The exact-match posted amount this month, or ``None`` when the
            stream did not post under its own ``(name, category)`` (or a USD row lacked a
            snapshot).
        expected: The stream's expected-this-month amount at offset 0, or ``None`` when it
            is not due this month (or a USD snapshot is missing). Also the target the loose
            fallback matches a pool charge against.
    """

    source: CommitmentSource
    name: str
    category: str | None
    exact_posted: Decimal | None
    expected: Decimal | None


@dataclass(frozen=True, slots=True)
class _LoosePair:
    """One eligible (pending stream, this-month charge) match for the closest-fit sweep (ADR-199).

    Built only for a candidate that has an ``expected`` and no exact match, paired with a
    same-category charge within tolerance. The sweep sorts these by ascending ``gap`` so the
    tightest fit is committed first.

    Attributes:
        gap: ``abs(charge.amount - expected)`` — the closeness of the fit (smaller is better).
        expected: The stream's expected amount (a tie-break: larger obligations first).
        candidate_index: The position of the stream in the candidate list.
        candidate_name: The stream's name (a deterministic tie-break).
        charge_index: The position of the charge in the (post-exact-removal) pool.
        charge: The matched charge; its amount becomes the stream's ``posted``.
    """

    gap: Decimal
    expected: Decimal
    candidate_index: int
    candidate_name: str
    charge_index: int
    charge: _PoolCharge


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


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
        """Assemble the owner's committed paid/pending split for a month (ADR-179, ADR-199, ADR-131).

        Subscription and instalment streams first take their exact ``(name, category)``
        this-month posted amount (the ADR-179 rule). A single pool of this-month expenses
        is then swept once, greedily, to fulfil any still-pending stream from a
        same-category charge within tolerance of its expected amount — the ADR-199 loose
        fallback that keeps renamed / untagged statement charges (ADR-198) from showing as
        false-pending. The monotributo tax leg is unchanged (ADR-177/179).
        """
        owner = UUID(user_id)
        is_usd = currency is Currency.USD
        target = month_key(month)

        subscription_candidates, subscription_unconverted = await self._subscription_candidates(
            owner, target=target, is_usd=is_usd
        )
        installment_candidates, installment_unconverted = await self._installment_candidates(
            owner, target=target, is_usd=is_usd
        )
        pool = await self._this_month_expense_pool(owner, target=target, is_usd=is_usd)

        streams = self._resolve_paid(subscription_candidates + installment_candidates, pool)
        tax_stream = await self._tax_stream(user_id, owner, month=month, target=target)
        if tax_stream is not None:
            streams.append(tax_stream)
        unconverted = subscription_unconverted + installment_unconverted if is_usd else 0
        return build_committed(target, currency.value, streams=streams, unconverted=unconverted)

    def _resolve_paid(
        self,
        candidates: list[_StreamCandidate],
        pool: list[_PoolCharge],
    ) -> list[CommittedStream]:
        """Turn stream candidates into committed streams, applying the loose paid fallback (ADR-199).

        A candidate whose exact ``(name, category)`` this-month match already posted keeps
        that posted figure (the ADR-179 first pass). Otherwise, when the stream is due this
        month (``expected`` set) it may be fulfilled by a same-category pool charge within
        :data:`_PAID_MATCH_TOLERANCE` of its expected amount.

        The loose sweep is a CLOSEST-FIT-FIRST greedy assignment, one-charge-per-stream:
        every eligible (candidate, charge) pair — same category, amount within tolerance —
        is ranked by ASCENDING gap ``abs(charge.amount - expected)`` so the tightest fit is
        assigned first, and each candidate and each charge is used at most once. This beats
        the naive "largest expected grabs the first in-tolerance charge" ordering, which
        could let a bigger stream steal a charge that fits a smaller same-category stream
        exactly — inverting paid/pending and shifting the subscription/installment split.
        Ranking on the gap (never on source) keeps the split correct without tagging the
        pool charges with a source. Ties break deterministically (larger expected, then
        candidate name, then a stable charge key). A stream left unmatched stays pending
        (``posted`` None), preserving the ADR-179 no-double-count invariant (paid XOR
        pending; the pending figure is never re-added to the spent total).
        """
        # An exact-match stream already claims its own this-month rows; drop them from the
        # pool so the loose fallback can never re-attribute them to another stream (a Netflix
        # charge that paid Netflix exactly must not also fulfil a same-category installment).
        exact_keys = {(c.name, c.category) for c in candidates if c.exact_posted is not None}
        remaining_pool = [charge for charge in pool if (charge.name, charge.category) not in exact_keys]

        # A stream with an exact match keeps its posted figure (ADR-179 first pass); a stream
        # with no expected this month is never a loose candidate — it starts pending (None).
        posted_by_index: dict[int, Decimal | None] = {
            i: candidate.exact_posted for i, candidate in enumerate(candidates)
        }
        for candidate_index, charge in self._assign_closest_fit(candidates, remaining_pool).items():
            posted_by_index[candidate_index] = charge.amount

        return [
            CommittedStream(source=candidate.source, posted=posted_by_index[i], expected=candidate.expected)
            for i, candidate in enumerate(candidates)
        ]

    def _assign_closest_fit(
        self,
        candidates: list[_StreamCandidate],
        pool: list[_PoolCharge],
    ) -> dict[int, _PoolCharge]:
        """Assign each still-pending stream its closest in-tolerance same-category charge (ADR-199).

        Builds every eligible (candidate, charge) pair — the candidate has an ``expected`` and
        no exact match, the charge shares its category, and ``abs(charge.amount - expected) <=
        expected * _PAID_MATCH_TOLERANCE`` — then greedily commits pairs in ASCENDING gap
        order so the tightest fit wins, each candidate and charge used at most once. Ties
        break deterministically on larger expected, then candidate name, then a stable
        per-charge key — never on source, so the split stays correct. Returns a map from
        candidate index to its matched charge; an unmatched candidate is simply absent (it
        stays pending).
        """
        pairs: list[_LoosePair] = []
        for candidate_index, candidate in enumerate(candidates):
            expected = candidate.expected
            if candidate.exact_posted is not None or expected is None or expected <= _ZERO:
                continue
            tolerance = expected * _PAID_MATCH_TOLERANCE
            for charge_index, charge in enumerate(pool):
                if charge.category == candidate.category and abs(charge.amount - expected) <= tolerance:
                    pairs.append(
                        _LoosePair(
                            gap=abs(charge.amount - expected),
                            expected=expected,
                            candidate_index=candidate_index,
                            candidate_name=candidate.name,
                            charge_index=charge_index,
                            charge=charge,
                        )
                    )

        # Tightest gap first; then larger expected, candidate name and a stable per-charge
        # key (name, amount, position) as deterministic tie-breaks — no source in the key.
        pairs.sort(key=lambda p: (p.gap, -p.expected, p.candidate_name, p.charge.name, p.charge.amount, p.charge_index))

        assignment: dict[int, _PoolCharge] = {}
        used_charges: set[int] = set()
        for pair in pairs:
            if pair.candidate_index in assignment or pair.charge_index in used_charges:
                continue
            assignment[pair.candidate_index] = pair.charge
            used_charges.add(pair.charge_index)
        return assignment

    async def _this_month_expense_pool(
        self,
        owner: UUID,
        *,
        target: str,
        is_usd: bool,
    ) -> list[_PoolCharge]:
        """Fetch the owner's this-month expenses available for the loose paid fallback (ADR-199).

        Every ``kind=expense`` row dated in the target month, denominated per the requested
        currency (ADR-168); rows that cannot be denominated (a USD row lacking a snapshot,
        ADR-152) are excluded, since they cannot be compared against a stream's expected
        amount. Fetched ONCE per :meth:`committed` call and consumed greedily by
        :meth:`_resolve_paid`.
        """
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.kind == Kind.EXPENSE.value,
            )
            .order_by(TransactionRecord.occurred_on.desc(), TransactionRecord.created_at.desc())
        )
        result = await self.session.execute(statement)
        pool: list[_PoolCharge] = []
        for record in result.scalars().all():
            if month_key(record.occurred_on) != target:
                continue
            amount = self._denominated_amount(record, is_usd=is_usd)
            if amount is None:
                continue
            pool.append(_PoolCharge(name=record.name, category=record.category, amount=amount))
        return pool

    async def _committed_expense_rows(self, owner: UUID, *, installments: bool) -> list[TransactionRecord]:
        """Return the owner's committed expense rows for one source, newest-first (ADR-108).

        Mirrors the forecast reader: fetches either the recurring-subscription source
        (a non-installment ``recurring_cadence``, ADR-199) or the instalment source
        (``recurring_cadence='installment'``), ordered ``(occurred_on DESC, created_at
        DESC)`` so the FIRST row seen per ``(name, category)`` stream is its LATEST actual
        occurrence. Every row is an EXPENSE scoped to the owner.
        """
        if installments:
            source_predicate = TransactionRecord.recurring_cadence == RecurringCadence.INSTALLMENT.value
        else:
            # A subscription stream is any expense carrying a NON-installment cadence
            # (ADR-199): recurrence lives on ``recurring_cadence`` (ADR-174), so the legacy
            # ``recurring`` boolean is no longer read as a source signal — in production it
            # matched zero rows. An instalment-marked row is excluded so a row never counts
            # as both a subscription and a tail.
            source_predicate = and_(
                TransactionRecord.recurring_cadence.is_not(None),
                TransactionRecord.recurring_cadence != RecurringCadence.INSTALLMENT.value,
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

    async def _subscription_candidates(
        self,
        owner: UUID,
        *,
        target: str,
        is_usd: bool,
    ) -> tuple[list[_StreamCandidate], int]:
        """Derive the subscription stream candidates for the target month (ADR-179, ADR-199).

        Collapses the owner's non-installment-cadence rows to one stream per ``(name,
        category)`` keyed off its LATEST occurrence (cadence, last-actual month, expected
        amount). ``exact_posted`` is the SUM of the stream's own rows dated in the target
        month; the expected amount applies only when the stream's cadence lands the target
        month strictly after its latest actual (offset 0 rule, ADR-176). The greedy loose
        fallback (ADR-199) runs later over the shared pool. On the USD path a stream whose
        latest row lacks a snapshot contributes to ``unconverted``.
        """
        rows = await self._committed_expense_rows(owner, installments=False)
        candidates: list[_StreamCandidate] = []
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
            exact_posted = self._posted_this_month(rows, key, target=target, is_usd=is_usd)
            expected = self._subscription_expected(record, amount, cadence=cadence, target=target)
            candidates.append(
                _StreamCandidate(
                    source=CommitmentSource.SUBSCRIPTION,
                    name=record.name,
                    category=record.category,
                    exact_posted=exact_posted,
                    expected=expected,
                )
            )
        return candidates, unconverted

    async def _installment_candidates(
        self,
        owner: UUID,
        *,
        target: str,
        is_usd: bool,
    ) -> tuple[list[_StreamCandidate], int]:
        """Derive the instalment plan candidates for the target month (ADR-179, ADR-199).

        Collapses the owner's instalment rows to one plan per ``(name, category)`` keyed
        off its LATEST occurrence. ``exact_posted`` is the SUM of the plan's cuotas dated in
        the target month; the expected amount applies only when the plan still has a
        remaining cuota AND its latest actual is a prior month (its tail reaches the target
        month, offset 0 rule, ADR-176). The greedy loose fallback (ADR-199) runs later over
        the shared pool. On the USD path a plan whose latest row lacks a snapshot
        contributes to ``unconverted``.
        """
        rows = await self._committed_expense_rows(owner, installments=True)
        candidates: list[_StreamCandidate] = []
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
            exact_posted = self._posted_this_month(rows, key, target=target, is_usd=is_usd)
            expected = self._installment_expected(record, amount, target=target)
            candidates.append(
                _StreamCandidate(
                    source=CommitmentSource.INSTALLMENT,
                    name=record.name,
                    category=record.category,
                    exact_posted=exact_posted,
                    expected=expected,
                )
            )
        return candidates, unconverted

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
        omitted). Otherwise: when one or more ``Taxes``-category expenses posted this month
        the tax leg is PAID at their ACTUAL summed amount (the real spend already inside the
        month's Expenses total, mirroring how subscriptions/instalments sum their real rows,
        ADR-179) and nothing is pending; when NONE posted the tax leg is PENDING at the
        monotributo SCALE cuota — the expected-this-month figure for a monthly committed
        outflow (ADR-177). The scale cuota therefore drives ONLY the pending case. Both legs
        are AFIP-ARS and ``ars_fixed`` so the engine sums the tax only on an ARS request
        (ADR-177). The scale cuota is resolved for the TARGET MONTH's vintage (ADR-067): a
        July-2026 split uses the 2026-02 cuota, an Aug-2026 split the 2026-08 one — the same
        as-of behavior the standing meter uses, so the figure never jumps ahead of the
        vintage's effective date.
        """
        cuota = await self._monotributo_cuota(user_id, as_of=month)
        if cuota is None or cuota <= Decimal(0):
            return None
        posted = await self._tax_posted_this_month(owner, month=month)
        if posted is not None:
            # A real Taxes outflow posted → paid is the ACTUAL spend, not the scale cuota (ADR-179).
            return CommittedStream(source=CommitmentSource.TAX, posted=posted, expected=None, ars_fixed=True)
        # Nothing posted → the scale cuota is the expected-this-month pending figure (ADR-177).
        return CommittedStream(source=CommitmentSource.TAX, posted=None, expected=cuota, ars_fixed=True)

    async def _tax_posted_this_month(self, owner: UUID, *, month: date) -> Decimal | None:
        """Return the SUM of AFIP (``Taxes``) expenses posted in the target month, or ``None`` (ADR-177/179).

        The cuota flips to paid at the ACTUAL amount once its AFIP outflow posts. A monotributo
        cuota is recorded in the ledger as an EXPENSE in the ``Taxes`` category (the only
        structured tax signal available — the ``counts_toward_monotributo`` flag is meaningful
        only for income / invoice, so an expense cannot carry it, ADR-158). This SUMs every such
        ``Taxes`` expense dated in the target month (their authoritative ARS ``amount``), so the
        paid figure is the real posted spend already inside the month's Expenses total — NOT the
        monotributo scale cuota (ADR-179). Returns ``None`` when no ``Taxes`` expense posted this
        month, so the caller keeps the known AFIP-ARS scale cuota as the pending figure.
        """
        upper = add_months(date(month.year, month.month, 1), 1)
        statement = select(func.coalesce(func.sum(TransactionRecord.amount), _ZERO)).where(
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.EXPENSE.value,
            TransactionRecord.category == _TAXES_CATEGORY,
            TransactionRecord.occurred_on >= date(month.year, month.month, 1),
            TransactionRecord.occurred_on < upper,
        )
        total = _as_decimal((await self.session.execute(statement)).scalar_one())
        # No Taxes expense posted (coalesced SUM is 0) → keep the scale cuota as pending (ADR-179).
        return total if total != _ZERO else None

    async def _monotributo_cuota(self, user_id: str, *, as_of: date) -> Decimal | None:
        """Return the owner's configured monotributo monthly cuota for ``as_of``, or ``None`` (ADR-177).

        Mirrors the forecast reader: reads the configured ``(category, activity_type)``
        from ``app_settings`` via the monotributo repository (ADR-112) and returns the
        services or goods cuota (ADR-046) from the scale vintage in effect on ``as_of``
        (ADR-067) — the target month's date — so the cuota tracks the standing's as-of
        behavior and never uses a future vintage. Returns ``None`` when the owner has no
        configured category.
        """
        configured = await self.monotributo.configured_category(user_id)
        if configured is None:
            return None
        category, activity_type = configured
        try:
            row = get_category(category, as_of=as_of)
        except KeyError:
            return None
        return row.cuota_servicios if activity_type == _SERVICES_ACTIVITY else row.cuota_bienes
