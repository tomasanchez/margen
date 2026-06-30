"""SQLAlchemy reader for the budget-income query side (ADR-139, ADR-143).

Runs read-only queries against an ``AsyncSession`` and projects them into the
net-income-base read model. The base + floor come from the ``budget_income`` table;
the variable-income suggestion sums the owner's inflow (income + invoice) per month
over the trailing-12-month window and applies the pure
:func:`margen_api.domain.models.budget_income.suggest_variable_base` rule. SQLAlchemy
stays in this adapter (AGENTS.md); the lower-of math is pure. Every query is
owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.budget_income import BudgetIncomeRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.queries import _as_decimal
from margen_api.domain.models.budget import month_start
from margen_api.domain.models.budget_income import is_sparse_history, suggest_variable_base
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.budget_income_read_models import BudgetIncomeReadModel, SuggestedBaseReadModel
from margen_api.service_layer.budget_income_reader import AbstractBudgetIncomeReader
from margen_api.service_layer.summaries import add_months, month_key

_MVP_CURRENCY = Currency.ARS
_ZERO = Decimal(0)

# Net spendable income is built from the inflow kinds (income + invoice), the same
# inflow basis the insights savings input uses (ADR-060): real money in.
_INFLOW_KINDS = (Kind.INCOME.value, Kind.INVOICE.value)

# The trailing window for the variable-income suggestion (product-deliverable §2.1):
# the 12 calendar months ending at and including the reference month.
_TRAILING_MONTHS = 12


class SqlAlchemyBudgetIncomeReader(AbstractBudgetIncomeReader):
    """Serve the net-income base + floor + suggestion from an async session (ADR-139)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def income(self, month: date, user_id: str) -> BudgetIncomeReadModel:
        """Return the owner's net-income base + floor for a month (ADR-139, ADR-143)."""
        owner = UUID(user_id)
        period = month_start(month)
        statement = select(
            BudgetIncomeRecord.amount,
            BudgetIncomeRecord.currency,
            BudgetIncomeRecord.source,
            BudgetIncomeRecord.floor_amount,
            BudgetIncomeRecord.floor_source,
        ).where(
            BudgetIncomeRecord.user_id == owner,
            BudgetIncomeRecord.period == period,
        )
        row = (await self.session.execute(statement)).first()
        if row is None:
            return BudgetIncomeReadModel(
                month=month_key(period),
                amount=None,
                currency=_MVP_CURRENCY,
                source=None,
                floor_amount=None,
                floor_source=None,
            )
        return BudgetIncomeReadModel(
            month=month_key(period),
            amount=row.amount,
            currency=Currency.parse(row.currency),
            source=row.source,
            floor_amount=row.floor_amount,
            floor_source=row.floor_source if row.floor_amount is not None else None,
        )

    async def suggested_base(
        self,
        month: date,
        user_id: str,
        currency: Currency = Currency.ARS,
    ) -> SuggestedBaseReadModel:
        """Apply the lower-of variable-income rule over the trailing ledger (ADR-139, ADR-152, ADR-153)."""
        owner = UUID(user_id)
        reference = month_start(month)
        monthly = await self._trailing_monthly_inflow(reference, owner, currency)
        months_available = len(monthly)
        return SuggestedBaseReadModel(
            suggested_base=suggest_variable_base(monthly),
            months_available=months_available,
            is_sparse=is_sparse_history(months_available),
            currency=currency,
        )

    async def _trailing_monthly_inflow(self, reference: date, owner: UUID, currency: Currency) -> list[Decimal]:
        """Return the owner's per-month inflow totals over the trailing-12 window (ADR-139, ADR-152).

        Only months that actually have inflow rows are summed; the relaxed suggestion
        rule (ADR-153) estimates from whatever months exist (≥ 1), so the returned
        count IS the ``monthsAvailable`` figure. ``currency`` selects the summed value
        (ADR-152): ``USD`` sums each inflow row's stored ``usd_amount`` snapshot and
        EXCLUDES rows lacking one (the same unconverted-exclusion as the budget spend
        path), ``ARS`` sums ``amount``. Rows are bucketed by month in Python (rather
        than a SQL ``date_trunc`` / ``strftime``) so the query stays portable across
        the PostgreSQL production target and the in-memory SQLite e2e tier (ADR-019).
        """
        is_usd = currency is Currency.USD
        value_column = TransactionRecord.usd_amount if is_usd else TransactionRecord.amount
        window_start = add_months(reference, -(_TRAILING_MONTHS - 1))
        window_end = add_months(reference, 1)  # exclusive upper bound
        predicates = [
            TransactionRecord.user_id == owner,
            TransactionRecord.kind.in_(_INFLOW_KINDS),
            TransactionRecord.occurred_on >= window_start,
            TransactionRecord.occurred_on < window_end,
        ]
        if is_usd:
            # USD inflow sums the stored snapshot; rows without one are excluded so a
            # null never poisons a month's total (ADR-152 unconverted-exclusion).
            predicates.append(TransactionRecord.usd_amount.is_not(None))
        statement = select(TransactionRecord.occurred_on, value_column.label("value")).where(*predicates)
        result = await self.session.execute(statement)
        totals: dict[date, Decimal] = {}
        for row in result.all():
            key = month_start(row.occurred_on)
            totals[key] = totals.get(key, _ZERO) + _as_decimal(row.value)
        return list(totals.values())
