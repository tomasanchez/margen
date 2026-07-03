"""SQLAlchemy reader for the account + net-worth query side (ADR-122, ADR-123, ADR-134).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
account read models. The per-account balance aggregation runs server-side SQL
(SUM of signed transaction deltas grouped by account, PLUS the net transfer flow:
``+amount_in`` for transfers INTO the account and ``-amount_out`` for transfers OUT
of it, ADR-135); the cross-currency conversion and the total sum live in the pure
:mod:`margen_api.service_layer.net_worth` so SQLAlchemy stays in this adapter
(AGENTS.md). Each account is joined to its owning institution so the list and
breakdown carry the institution ``name`` + ``type`` denormalized (ADR-134). Every
query is owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import ColumnElement, Numeric, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from margen_api.adapters.models.account import AccountRecord
from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.institution import InstitutionRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.models.transfer import TransferRecord
from margen_api.adapters.settings_repository import DEFAULT_DISPLAY_CURRENCY
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind, RecurringCadence
from margen_api.service_layer.account_read_models import AccountReadModel, NetWorth
from margen_api.service_layer.account_reader import AbstractAccountReader
from margen_api.service_layer.net_worth import (
    AccountBalanceInput,
    CcBalanceInput,
    InstallmentLiabilityInput,
    build_net_worth,
)

_ZERO = Decimal(0)

# The native-currency magnitude a transaction contributes to its account's balance.
# For a USD account the USD-native ``usd_amount`` keeps the balance USD-authoritative
# (ADR-123); when a USD row carries no ``usd_amount`` (incomplete FX, ADR-031) the
# ARS-equivalent ``amount`` is the only figure available, so fall back to it. ARS
# accounts always use ``amount`` (the ARS-equivalent magnitude, ADR-025).
_NATIVE_MAGNITUDE = case(
    (
        AccountRecord.currency == Currency.USD.value,
        func.coalesce(TransactionRecord.usd_amount, TransactionRecord.amount),
    ),
    else_=TransactionRecord.amount,
)
# A transaction's signed contribution: ``-magnitude`` for an expense, ``+magnitude``
# for every inflow — income, invoice AND reimbursement (the magnitude is always
# positive, ADR-025). A reimbursement is real cash received, so it credits the account
# balance and net worth exactly like any deposit (ADR-158/162 balance row): the
# ``else_`` branch covers it with no kind-specific change. SUM widens NUMERIC, so it is
# cast back so the driver returns a Decimal for money (ADR-025).
_SIGNED_DELTA = case(
    (TransactionRecord.kind == Kind.EXPENSE.value, -_NATIVE_MAGNITUDE),
    else_=_NATIVE_MAGNITUDE,
)
_DELTA_SUM = cast(func.coalesce(func.sum(_SIGNED_DELTA), _ZERO), Numeric(18, 2))


def _transfer_delta(account_id_column: InstrumentedAttribute[UUID], today: date) -> ColumnElement[Decimal]:
    """Build the net transfer flow for an account as a correlated scalar (ADR-135, ADR-186).

    A transfer moves money in the accounts' native currencies (ADR-123), so no FX is
    applied here: the destination is credited ``amount_in`` and the source is debited
    ``amount_out``. The two sums are computed as separate correlated scalar subqueries
    (rather than extra joins) so they do not fan out the per-account transaction
    aggregation. Only transfers dated on or before ``today`` count — net worth is an
    as-of-today snapshot (ADR-186), so a future-dated transfer has not moved yet.
    ``coalesce`` keeps an account with no transfers at zero, and the result is cast back
    to ``NUMERIC(18, 2)`` so the driver returns a Decimal for money (ADR-025).

    Args:
        account_id_column: The outer ``AccountRecord.id`` column the subqueries
            correlate against.
        today: The as-of reference date; only transfers dated on or before it count.

    Returns:
        A scalar SQL expression: ``Σ amount_in (to this account) - Σ amount_out
        (from this account)``, restricted to transfers dated on or before ``today``.
    """
    credited = (
        select(func.coalesce(func.sum(TransferRecord.amount_in), _ZERO))
        .where(TransferRecord.to_account_id == account_id_column, TransferRecord.occurred_on <= today)
        .scalar_subquery()
    )
    debited = (
        select(func.coalesce(func.sum(TransferRecord.amount_out), _ZERO))
        .where(TransferRecord.from_account_id == account_id_column, TransferRecord.occurred_on <= today)
        .scalar_subquery()
    )
    return cast(credited - debited, Numeric(18, 2))


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _today() -> date:
    """Return today's date (UTC) as the net-worth as-of reference (ADR-186).

    Net worth is an as-of-today snapshot (ADR-122/186): a charge dated after today has
    not left the account yet, so it is excluded from the asset balance and reserved as
    the ccBalance liability instead — each peso counts once. Mirrors the forecast's
    reference date (ADR-176) so both query sides agree on "now".
    """
    return datetime.now(UTC).date()


class SqlAlchemyAccountReader(AbstractAccountReader):
    """Serve the accounts list and net worth from an async session (ADR-122)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_accounts(self, user_id: str) -> list[AccountReadModel]:
        """List the owner's accounts newest-first by creation, with institution data (ADR-130, ADR-134)."""
        statement = (
            select(
                AccountRecord.id,
                AccountRecord.institution_id,
                InstitutionRecord.name,
                InstitutionRecord.type,
                AccountRecord.currency,
                AccountRecord.opening_balance,
            )
            .join(InstitutionRecord, InstitutionRecord.id == AccountRecord.institution_id)
            .where(AccountRecord.user_id == UUID(user_id))
            .order_by(AccountRecord.created_at.desc(), AccountRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [
            AccountReadModel(
                id=row.id,
                institution_id=row.institution_id,
                institution_name=row.name,
                type=InstitutionType.parse(row.type),
                currency=Currency.parse(row.currency),
                opening_balance=row.opening_balance,
            )
            for row in result.all()
        ]

    async def net_worth(self, user_id: str) -> NetWorth:
        """Compute the owner's net worth, liabilities and per-account breakdown (ADR-122, ADR-123, ADR-180, ADR-185).

        Net worth is an as-of-today snapshot (ADR-186): the asset balances exclude
        future-dated (not-yet-due) charges, and those same outstanding CARD-account
        charges are reserved as the ccBalance liability instead, so each peso counts
        exactly once and ``net_after_liabilities`` never double-counts (ADR-185/186).
        """
        owner = UUID(user_id)
        today = _today()
        balances = await self._account_balances(owner, today)
        display_currency = await self._display_currency(owner)
        mep_rate = await self._latest_mep_rate(owner)
        installment_liabilities = await self._installment_liabilities(owner)
        cc_balance_liabilities = await self._cc_balance_liabilities(owner, today)
        return build_net_worth(
            balances,
            display_currency=display_currency,
            mep_rate=mep_rate,
            installment_liabilities=installment_liabilities,
            cc_balance_liabilities=cc_balance_liabilities,
        )

    async def _installment_liabilities(self, owner: UUID) -> list[InstallmentLiabilityInput]:
        """Return the owner's active instalment tails for the liabilities reservation (ADR-181, ADR-182).

        Fetches the owner's instalment-marked expense rows (``recurring_cadence=
        'installment'``) newest-first and collapses them to one plan per ``(name,
        category)`` keyed off each plan's LATEST posted cuota. Each plan yields its native
        per-cuota amount, its native currency and its remaining count (``installments_total
        - installments_index`` from the latest posted cuota, floored at ``0`` — so paid
        cuotas are excluded by construction, the no-double-count property, ADR-181). A plan
        with no structured total/index, or already fully paid, yields ``remaining_count=0``
        and contributes nothing. Recurring subscriptions and the monotributo cuota are
        NOT instalment streams and never enter this reservation (ADR-182). Owner-scoped
        (ADR-108, ADR-130).
        """
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.recurring_cadence == RecurringCadence.INSTALLMENT.value,
            )
            .order_by(TransactionRecord.occurred_on.desc(), TransactionRecord.created_at.desc())
        )
        result = await self.session.execute(statement)
        streams: list[InstallmentLiabilityInput] = []
        seen: set[tuple[str, str | None]] = set()
        for record in result.scalars().all():
            key = (record.name, record.category)
            if key in seen:
                continue
            seen.add(key)
            streams.append(
                InstallmentLiabilityInput(
                    amount=self._native_cuota_amount(record),
                    currency=Currency.parse(record.currency),
                    remaining_count=self._remaining_count(record),
                )
            )
        return streams

    def _native_cuota_amount(self, record: TransactionRecord) -> Decimal:
        """Return an instalment cuota's NATIVE per-cuota amount (ADR-123, ADR-181).

        A USD cuota uses the USD-native ``usd_amount`` snapshot so the tail stays
        USD-authoritative (ADR-123); when a USD row carries no snapshot the ARS-equivalent
        ``amount`` is the only figure available, so it is the fallback (degrade to native,
        consistent with net worth, ADR-132). An ARS cuota always uses ``amount`` (ADR-025).
        """
        if Currency.parse(record.currency) is Currency.USD and record.usd_amount is not None:
            return record.usd_amount
        return record.amount

    def _remaining_count(self, record: TransactionRecord) -> int:
        """Return an instalment plan's remaining cuotas from its latest posted row (ADR-181).

        ``installments_total - installments_index``, floored at ``0``; ``0`` when either
        figure is missing (no structured tail). Measured from the latest posted cuota so
        paid cuotas are excluded by construction (the no-double-count property, ADR-181).
        """
        total = record.installments_total
        index = record.installments_index
        if total is None or index is None:
            return 0
        return max(0, total - index)

    async def _cc_balance_liabilities(self, owner: UUID, today: date) -> list[CcBalanceInput]:
        """Return the owner's unpaid credit-card balance as native per-currency subtotals (ADR-185).

        Sums the owner's CARD-institution account charges that are (a) EXPENSE rows on a
        ``CARD``-type institution account, (b) FUTURE-dated (``occurred_on > today`` — not
        yet due under the pay-date convention, so still outstanding, ADR-089), and (c) NOT
        ``recurring_cadence='installment'`` (excluded — the instalment tail is counted
        separately, ADR-181/185). The outstanding balance uses the NATIVE magnitude
        (:data:`_NATIVE_MAGNITUDE`): a USD card row sums its USD-native figure so the balance
        stays USD-authoritative (ADR-123), an ARS row its ARS amount. Each charge is a debt
        owed, so it is a POSITIVE liability (unlike the asset side, where a card expense is a
        ``-magnitude`` reduction). Grouped by the account currency so ARS and USD balances
        stay separate for live-rate client conversion (ADR-183). These SAME charges are
        excluded from :meth:`_account_balances` (as-of-today), so folding them here as a
        liability counts each peso once (the no-double-count invariant, ADR-186).
        Owner-scoped (ADR-108, ADR-130).

        Args:
            owner: The authenticated owner whose card balances are summed.
            today: The as-of reference date; only charges dated strictly after it count.

        Returns:
            One :class:`CcBalanceInput` per native currency that has an outstanding
            balance; an empty list when the owner has no outstanding card charges.
        """
        statement = (
            select(
                AccountRecord.currency,
                cast(func.coalesce(func.sum(_NATIVE_MAGNITUDE), _ZERO), Numeric(18, 2)).label("balance"),
            )
            .select_from(TransactionRecord)
            .join(AccountRecord, AccountRecord.id == TransactionRecord.account_id)
            .join(InstitutionRecord, InstitutionRecord.id == AccountRecord.institution_id)
            .where(
                TransactionRecord.user_id == owner,
                # EXPENSE only: credits/payments (income / reimbursement rows) are
                # intentionally NOT netted against the balance in this slice — netting
                # credits is deferred (ADR-185).
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.occurred_on > today,
                InstitutionRecord.type == InstitutionType.CARD.value,
                TransactionRecord.recurring_cadence.is_distinct_from(RecurringCadence.INSTALLMENT.value),
            )
            .group_by(AccountRecord.currency)
        )
        result = await self.session.execute(statement)
        return [
            CcBalanceInput(amount=_as_decimal(row.balance), currency=Currency.parse(row.currency))
            for row in result.all()
        ]

    async def _account_balances(self, owner: UUID, today: date) -> list[AccountBalanceInput]:
        """Return each of the owner's accounts with its native balance (ADR-122, ADR-134, ADR-135).

        Balance = ``opening_balance + Σ signed transaction deltas + net transfer
        flow``, where the net transfer flow is ``+Σ amount_in`` for transfers INTO the
        account and ``-Σ amount_out`` for transfers OUT of it (ADR-135). Net worth is an
        as-of-today snapshot (ADR-186): only transactions/transfers dated on or before
        ``today`` contribute, so a FUTURE-dated (not-yet-due) card charge does NOT reduce
        the asset balance — it is reserved instead as the ccBalance liability
        (:meth:`_cc_balance_liabilities`), so each peso counts exactly once and
        ``net_after_liabilities`` never double-counts (ADR-185/186). The as-of filter is on
        the ``LEFT OUTER JOIN`` condition (not the WHERE) so an account whose only movements
        are future-dated still appears with a zero transaction delta rather than dropping
        from the breakdown. The transfer flow is two correlated scalar subqueries so it does
        not fan out the transaction grouping. The institution join supplies the denormalized
        ``name`` + ``type``. Ordered newest-first to match :meth:`list_accounts`.
        """
        transfer_delta = _transfer_delta(AccountRecord.id, today)
        statement = (
            select(
                AccountRecord.id,
                AccountRecord.institution_id,
                InstitutionRecord.name,
                InstitutionRecord.type,
                AccountRecord.currency,
                AccountRecord.opening_balance,
                _DELTA_SUM.label("delta"),
                transfer_delta.label("transfer_delta"),
            )
            .select_from(AccountRecord)
            .join(InstitutionRecord, InstitutionRecord.id == AccountRecord.institution_id)
            .outerjoin(
                TransactionRecord,
                (TransactionRecord.account_id == AccountRecord.id) & (TransactionRecord.occurred_on <= today),
            )
            .where(AccountRecord.user_id == owner)
            .group_by(
                AccountRecord.id,
                AccountRecord.institution_id,
                InstitutionRecord.name,
                InstitutionRecord.type,
                AccountRecord.currency,
                AccountRecord.opening_balance,
            )
            .order_by(AccountRecord.created_at.desc(), AccountRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [
            AccountBalanceInput(
                id=row.id,
                institution_id=row.institution_id,
                institution_name=row.name,
                type=InstitutionType.parse(row.type),
                currency=Currency.parse(row.currency),
                balance=_as_decimal(row.opening_balance) + _as_decimal(row.delta) + _as_decimal(row.transfer_delta),
            )
            for row in result.all()
        ]

    async def _display_currency(self, owner: UUID) -> Currency:
        """Return the owner's preferred display currency, or the default (ADR-056, ADR-110)."""
        statement = select(AppSettingsRecord.preferred_display_currency).where(AppSettingsRecord.user_id == owner)
        value = (await self.session.execute(statement)).scalar_one_or_none()
        return Currency.parse(value if value is not None else DEFAULT_DISPLAY_CURRENCY)

    async def _latest_mep_rate(self, owner: UUID) -> Decimal | None:
        """Return the owner's most recently observed USD MEP rate, or ``None`` (ADR-123).

        There is no server-side FX feed (ADR-056 keeps display conversion on the
        client); the only ARS-per-USD figure the backend holds is the ``fx_rate``
        the user confirmed on their USD rows (ADR-044/045). The most recent such
        rate is reused as the net-worth MEP rate. When the owner has never recorded
        a USD rate, ``None`` is returned and cross-currency balances degrade to
        native (ADR-132).
        """
        statement = (
            select(TransactionRecord.fx_rate)
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.currency == Currency.USD.value,
                TransactionRecord.fx_rate.is_not(None),
            )
            .order_by(TransactionRecord.fx_rate_as_of.desc().nulls_last(), TransactionRecord.occurred_on.desc())
            .limit(1)
        )
        rate = (await self.session.execute(statement)).scalar_one_or_none()
        return None if rate is None else _as_decimal(rate)
