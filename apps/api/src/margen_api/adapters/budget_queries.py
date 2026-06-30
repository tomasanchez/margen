"""SQLAlchemy reader for the budgets query side (ADR-125, ADR-042).

Runs read-only queries against an ``AsyncSession`` and projects rows into the
budgets-vs-actuals read model. The per-category targets come from the ``budgets``
table; the per-category month spend is the SAME aggregation the summaries reader
uses — :func:`margen_api.adapters.queries.month_category_expense_totals` — so the
budgets "spent" is identical to the summaries "amount" rather than a reinvented
query (ADR-042, ADR-125). The target/actual join and the ``remaining`` math live in
the pure :mod:`margen_api.service_layer.budgets` so SQLAlchemy stays in this adapter
(AGENTS.md). Every query is owner-scoped (ADR-130). All I/O is awaited.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.budget import BudgetRecord
from margen_api.adapters.queries import month_category_expense_totals
from margen_api.domain.models.budget import month_start
from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.budget_read_models import MonthlyBudget
from margen_api.service_layer.budget_reader import AbstractBudgetReader
from margen_api.service_layer.budgets import build_budget_lines
from margen_api.service_layer.summaries import month_key

# For the MVP every figure is ARS-equivalent: targets are stored ARS and the spend
# is the ARS-equivalent category total, so the surface reports ARS (ADR-125).
_MVP_CURRENCY = Currency.ARS


class SqlAlchemyBudgetReader(AbstractBudgetReader):
    """Serve budgets vs actuals from an async session (ADR-125)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def monthly_budget(self, month: date, user_id: str) -> MonthlyBudget:
        """Join the owner's targets with the month's per-category spend (ADR-125, ADR-108)."""
        owner = UUID(user_id)
        period = month_start(month)
        targets = await self._targets(period, owner)
        spent = await month_category_expense_totals(self.session, period, owner)
        return MonthlyBudget(
            month=month_key(period),
            currency=_MVP_CURRENCY,
            categories=build_budget_lines(targets, spent),
        )

    async def _targets(self, period: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's per-category targets for the month keyed by category (ADR-130)."""
        statement = select(BudgetRecord.category, BudgetRecord.amount).where(
            BudgetRecord.user_id == owner,
            BudgetRecord.period == period,
        )
        result = await self.session.execute(statement)
        return {str(row.category): row.amount for row in result.all()}
