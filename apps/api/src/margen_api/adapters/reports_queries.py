"""SQLAlchemy reader for the reports query side (ADR-163, ADR-164).

Runs read-only queries against an ``AsyncSession`` to build the net-worth history
series. The cumulative roll-up and windowing live in the pure
:mod:`margen_api.service_layer.net_worth_history`; this adapter only does the SQL
(AGENTS.md). Two aggregates feed the series, mirroring the current snapshot's
signed-delta + transfer-flow model (ADR-122/123/135) but grouped by month:

* the SUM of every account's ``opening_balance`` per currency (the starting point);
* the per-month INCREMENTAL signed flow per currency — transaction deltas
  (``+`` inflow, ``-`` expense, in the account's native magnitude) PLUS the net
  transfer flow (``+amount_in`` to a destination, ``-amount_out`` from a source).

Flow dated BEFORE the window's first month is folded into that first month's key so
a balance carried into the window is reflected, not lost. No FX conversion happens
here — the series is per-currency native (ADR-164). Every query is owner-scoped
(ADR-131). All I/O is awaited.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.account import AccountRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.models.transfer import TransferRecord
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.net_worth_history import (
    DEFAULT_MONTHS,
    build_net_worth_history,
    clamp_months,
    history_window,
    month_key,
)
from margen_api.service_layer.reports_read_models import NetWorthHistory
from margen_api.service_layer.reports_reader import AbstractReportsReader

_ZERO = Decimal(0)


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class SqlAlchemyReportsReader(AbstractReportsReader):
    """Serve the net-worth history series from server-side SQL (ADR-164)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def net_worth_history(self, user_id: str, *, months: int = DEFAULT_MONTHS) -> NetWorthHistory:
        """Build the owner's cumulative month-END net-worth history per currency (ADR-164, ADR-131)."""
        owner = UUID(user_id)
        window = clamp_months(months)
        reference = datetime.now(UTC).date()
        first_month = history_window(reference, window)[0]

        opening = await self._opening_by_currency(owner)
        flow = await self._monthly_flow_by_currency(owner, first_month)
        return build_net_worth_history(
            reference,
            window,
            opening_by_currency=opening,
            monthly_flow_by_currency=flow,
        )

    async def _opening_by_currency(self, owner: UUID) -> dict[Currency, Decimal]:
        """Return the SUM of the owner's account opening balances keyed by currency (ADR-131)."""
        opening_sum = cast(func.coalesce(func.sum(AccountRecord.opening_balance), _ZERO), Numeric(18, 2))
        statement = (
            select(AccountRecord.currency, opening_sum.label("total"))
            .where(AccountRecord.user_id == owner)
            .group_by(AccountRecord.currency)
        )
        result = await self.session.execute(statement)
        return {Currency.parse(row.currency): _as_decimal(row.total) for row in result.all()}

    async def _monthly_flow_by_currency(
        self,
        owner: UUID,
        first_month: date,
    ) -> dict[Currency, dict[str, Decimal]]:
        """Return the per-month incremental signed flow keyed by currency then ``YYYY-MM`` (ADR-164).

        Combines the transaction signed deltas and the net transfer flow, each in
        the account's native currency. Flow dated before ``first_month`` is folded
        into ``first_month``'s key so the opening cumulative includes it (a balance
        carried into the window is not lost).
        """
        flow: dict[Currency, dict[str, Decimal]] = {}
        for currency, key, amount in await self._transaction_flow(owner, first_month):
            flow.setdefault(currency, {}).setdefault(key, _ZERO)
            flow[currency][key] += amount
        for currency, key, amount in await self._transfer_flow(owner, first_month):
            flow.setdefault(currency, {}).setdefault(key, _ZERO)
            flow[currency][key] += amount
        return flow

    def _bucket(self, occurred_on: date, first_month: date) -> str:
        """Bucket a movement date into its ``YYYY-MM`` key, clamped to the window start.

        A movement before ``first_month`` folds into the first month so its balance
        contribution lands in the opening cumulative rather than being dropped.
        """
        if occurred_on < first_month:
            return month_key(first_month)
        return month_key(occurred_on)

    async def _transaction_flow(
        self,
        owner: UUID,
        first_month: date,
    ) -> list[tuple[Currency, str, Decimal]]:
        """Return each account-linked transaction's signed native delta bucketed by month (ADR-122).

        The signed delta is ``-magnitude`` for an expense and ``+magnitude`` for every
        inflow (income / invoice / reimbursement), in the account's native currency
        (ADR-123). Only transactions attributed to an account contribute to net worth
        (a null ``account_id`` is excluded, ADR-122). Scoped to the owner (ADR-131).
        """
        native_usd = func.coalesce(TransactionRecord.usd_amount, TransactionRecord.amount)
        statement = (
            select(
                AccountRecord.currency.label("currency"),
                TransactionRecord.occurred_on.label("occurred_on"),
                TransactionRecord.kind.label("kind"),
                TransactionRecord.amount.label("amount"),
                native_usd.label("native_usd"),
            )
            .join(AccountRecord, AccountRecord.id == TransactionRecord.account_id)
            .where(TransactionRecord.user_id == owner)
        )
        result = await self.session.execute(statement)
        flows: list[tuple[Currency, str, Decimal]] = []
        for row in result.all():
            currency = Currency.parse(row.currency)
            magnitude = _as_decimal(row.native_usd) if currency is Currency.USD else _as_decimal(row.amount)
            delta = -magnitude if Kind.parse(row.kind) is Kind.EXPENSE else magnitude
            flows.append((currency, self._bucket(row.occurred_on, first_month), delta))
        return flows

    async def _transfer_flow(
        self,
        owner: UUID,
        first_month: date,
    ) -> list[tuple[Currency, str, Decimal]]:
        """Return each transfer's native flow — credit to destination, debit from source (ADR-135).

        A transfer adds ``amount_in`` to its destination account's currency and
        subtracts ``amount_out`` from its source account's currency, in each account's
        native currency (ADR-123), so a same-currency transfer nets to zero in the
        series. Scoped to the owner (ADR-131).
        """
        source = AccountRecord.__table__.alias("source_account")
        destination = AccountRecord.__table__.alias("destination_account")
        statement = (
            select(
                source.c.currency.label("source_currency"),
                destination.c.currency.label("destination_currency"),
                TransferRecord.amount_out.label("amount_out"),
                TransferRecord.amount_in.label("amount_in"),
                TransferRecord.occurred_on.label("occurred_on"),
            )
            .join(source, source.c.id == TransferRecord.from_account_id)
            .join(destination, destination.c.id == TransferRecord.to_account_id)
            .where(TransferRecord.user_id == owner)
        )
        result = await self.session.execute(statement)
        flows: list[tuple[Currency, str, Decimal]] = []
        for row in result.all():
            key = self._bucket(row.occurred_on, first_month)
            flows.append((Currency.parse(row.destination_currency), key, _as_decimal(row.amount_in)))
            flows.append((Currency.parse(row.source_currency), key, -_as_decimal(row.amount_out)))
        return flows
