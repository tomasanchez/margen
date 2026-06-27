"""SQLAlchemy reader for the account + net-worth query side (ADR-122, ADR-123).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
account read models. The per-account balance aggregation runs server-side SQL
(SUM of signed deltas grouped by account); the cross-currency conversion and the
total sum live in the pure :mod:`margen_api.service_layer.net_worth` so SQLAlchemy
stays in this adapter (AGENTS.md). Every query is owner-scoped (ADR-130). All I/O
is awaited.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.account import AccountRecord
from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.settings_repository import DEFAULT_DISPLAY_CURRENCY
from margen_api.domain.models.value_objects import AccountType, Currency, Kind
from margen_api.service_layer.account_read_models import AccountReadModel, NetWorth
from margen_api.service_layer.account_reader import AbstractAccountReader
from margen_api.service_layer.net_worth import AccountBalanceInput, build_net_worth

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
# for income / invoice (the magnitude is always positive, ADR-025). SUM widens
# NUMERIC, so it is cast back so the driver returns a Decimal for money (ADR-025).
_SIGNED_DELTA = case(
    (TransactionRecord.kind == Kind.EXPENSE.value, -_NATIVE_MAGNITUDE),
    else_=_NATIVE_MAGNITUDE,
)
_DELTA_SUM = cast(func.coalesce(func.sum(_SIGNED_DELTA), _ZERO), Numeric(18, 2))


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class SqlAlchemyAccountReader(AbstractAccountReader):
    """Serve the accounts list and net worth from an async session (ADR-122)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_accounts(self, user_id: str) -> list[AccountReadModel]:
        """List the owner's accounts newest-first by creation (ADR-130)."""
        statement = (
            select(AccountRecord)
            .where(AccountRecord.user_id == UUID(user_id))
            .order_by(AccountRecord.created_at.desc(), AccountRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]

    async def net_worth(self, user_id: str) -> NetWorth:
        """Compute the owner's net worth and per-account breakdown (ADR-122, ADR-123)."""
        owner = UUID(user_id)
        balances = await self._account_balances(owner)
        display_currency = await self._display_currency(owner)
        mep_rate = await self._latest_mep_rate(owner)
        return build_net_worth(balances, display_currency=display_currency, mep_rate=mep_rate)

    async def _account_balances(self, owner: UUID) -> list[AccountBalanceInput]:
        """Return each of the owner's accounts with its native balance (ADR-122).

        Balance = ``opening_balance + Σ signed deltas`` of the account's
        transactions. A ``LEFT OUTER JOIN`` keeps accounts with no transactions
        (their balance is just the opening balance). Ordered newest-first to match
        :meth:`list_accounts`.
        """
        statement = (
            select(
                AccountRecord.id,
                AccountRecord.name,
                AccountRecord.currency,
                AccountRecord.opening_balance,
                _DELTA_SUM.label("delta"),
            )
            .select_from(AccountRecord)
            .outerjoin(TransactionRecord, TransactionRecord.account_id == AccountRecord.id)
            .where(AccountRecord.user_id == owner)
            .group_by(
                AccountRecord.id,
                AccountRecord.name,
                AccountRecord.currency,
                AccountRecord.opening_balance,
            )
            .order_by(AccountRecord.created_at.desc(), AccountRecord.id.desc())
        )
        result = await self.session.execute(statement)
        return [
            AccountBalanceInput(
                id=row.id,
                name=row.name,
                currency=Currency.parse(row.currency),
                balance=_as_decimal(row.opening_balance) + _as_decimal(row.delta),
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


def _to_read_model(record: AccountRecord) -> AccountReadModel:
    """Project a persisted account row into a read model (ADR-122)."""
    return AccountReadModel(
        id=record.id,
        name=record.name,
        type=AccountType.parse(record.type),
        currency=Currency.parse(record.currency),
        opening_balance=record.opening_balance,
    )
