"""SQLAlchemy reader for the budgets query side (ADR-125, ADR-042, ADR-138, ADR-143).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
budgets-vs-actuals read model. The per-category SPEND targets come from the
``budgets`` table filtered to ``kind='spend'``; the per-category month spend is the
SAME aggregation the summaries reader uses —
:func:`margen_api.adapters.queries.month_category_expense_totals` — so the budgets
"spent" is identical to the summaries "amount" (ADR-042, ADR-125). The SAVING rows
(``kind='saving'``) are projected separately into the savings section — they have no
expense actuals so they MUST NOT join the vs-actuals query (ADR-138). The month's
net-income base + household floor come from ``budget_income`` (ADR-139, ADR-143), and
the strategy suggestion + income-pressure segment are computed by the pure
:mod:`margen_api.domain.models.strategy` from those figures. The join and assembly
math live in pure modules so SQLAlchemy stays in this adapter (AGENTS.md). Every query
is owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.budget import BudgetRecord
from margen_api.adapters.models.budget_income import BudgetIncomeRecord
from margen_api.adapters.queries import month_category_expense_totals
from margen_api.domain.models.budget import month_start
from margen_api.domain.models.strategy import income_pressure, suggest_strategy
from margen_api.domain.models.value_objects import BudgetKind, Currency
from margen_api.service_layer.budget_read_models import Floor, MonthlyBudget
from margen_api.service_layer.budget_reader import AbstractBudgetReader
from margen_api.service_layer.budgets import build_budget_lines, build_saving_lines
from margen_api.service_layer.summaries import month_key

# For the MVP every figure is ARS-equivalent: targets are stored ARS and the spend
# is the ARS-equivalent category total, so the surface reports ARS (ADR-125).
_MVP_CURRENCY = Currency.ARS

# The debt-service minimum is a manual, non-persisted UI field (budget-design §9.1.2),
# so the read side has no debt figure to score against: the suggestion is computed
# with a zero debt minimum here, and the frontend refines it when the user types one.
_NO_DEBT_MINIMUM = Decimal(0)


class SqlAlchemyBudgetReader(AbstractBudgetReader):
    """Serve budgets vs actuals + savings + floor from an async session (ADR-125, ADR-138)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def monthly_budget(self, month: date, user_id: str) -> MonthlyBudget:
        """Join the owner's targets, spend, savings, income and floor for a month (ADR-125, ADR-138)."""
        owner = UUID(user_id)
        period = month_start(month)
        targets = await self._targets(period, owner)
        spent = await month_category_expense_totals(self.session, period, owner)
        savings = await self._savings(period, owner)
        income, floor_amount, floor_source = await self._income_and_floor(period, owner)
        return MonthlyBudget(
            month=month_key(period),
            currency=_MVP_CURRENCY,
            categories=build_budget_lines(targets, spent),
            savings=build_saving_lines(savings, income),
            floor=Floor(amount=floor_amount, source=floor_source if floor_amount is not None else None),
            suggested_strategy=self._suggested_strategy(income, floor_amount),
            pressure=self._pressure(income, floor_amount),
        )

    async def _targets(self, period: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's per-category SPEND targets for the month (ADR-138, ADR-130).

        Filters ``kind='spend'`` so saving-bucket rows (which have no expense
        actuals) never surface as fake spend in the vs-actuals join (ADR-138).
        """
        statement = select(BudgetRecord.category, BudgetRecord.amount).where(
            BudgetRecord.user_id == owner,
            BudgetRecord.period == period,
            BudgetRecord.kind == BudgetKind.SPEND.value,
        )
        result = await self.session.execute(statement)
        return {str(row.category): row.amount for row in result.all()}

    async def _savings(self, period: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's per-bucket SAVING allocations for the month (ADR-138, ADR-130)."""
        statement = select(BudgetRecord.category, BudgetRecord.amount).where(
            BudgetRecord.user_id == owner,
            BudgetRecord.period == period,
            BudgetRecord.kind == BudgetKind.SAVING.value,
        )
        result = await self.session.execute(statement)
        return {str(row.category): row.amount for row in result.all()}

    async def _income_and_floor(self, period: date, owner: UUID) -> tuple[Decimal | None, Decimal | None, str | None]:
        """Return the owner's net-income base, floor amount and floor source (ADR-139, ADR-143)."""
        statement = select(
            BudgetIncomeRecord.amount,
            BudgetIncomeRecord.floor_amount,
            BudgetIncomeRecord.floor_source,
        ).where(
            BudgetIncomeRecord.user_id == owner,
            BudgetIncomeRecord.period == period,
        )
        row = (await self.session.execute(statement)).first()
        if row is None:
            return None, None, None
        return row.amount, row.floor_amount, row.floor_source

    @staticmethod
    def _suggested_strategy(income: Decimal | None, floor: Decimal | None) -> str | None:
        """Compute the strategy suggestion, or ``None`` when there is no income base (ADR-143)."""
        if income is None:
            return None
        return suggest_strategy(income, floor if floor is not None else Decimal(0), _NO_DEBT_MINIMUM).value

    @staticmethod
    def _pressure(income: Decimal | None, floor: Decimal | None) -> str | None:
        """Compute the income-pressure segment, or ``None`` when there is no income base (ADR-143)."""
        if income is None:
            return None
        return income_pressure(income, floor if floor is not None else Decimal(0))
