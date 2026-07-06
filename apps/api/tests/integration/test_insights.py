"""Integration tests for the insights reader against real PostgreSQL (ADR-060, ADR-061).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove the server-side ``SUM`` / ``GROUP BY`` / latest-row aggregation, the
prior-month mover delta, the recurring footprint, the income-minus-expense
savings and the latest-USD-invoice selection actually work end to end over real
data — what the mocked fast tiers cannot verify. A fixed reference date keeps the
savings projection deterministic and clock-independent.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.account_repository import SqlAlchemyAccountRepository
from margen_api.adapters.institution_repository import SqlAlchemyInstitutionRepository
from margen_api.adapters.queries import SqlAlchemyInsightsReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.account import build_account
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, FxRateType, InstitutionType, Kind

pytestmark = pytest.mark.integration

# A stable creation timestamp so the latest-USD tiebreak is deterministic.
_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)

# Two distinct owners prove the insights are scoped to the caller (ADR-108).
OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"


def _expense(
    occurred_on: date,
    amount: str,
    category: str | None,
    *,
    recurring: bool = False,
    name: str = "Spend",
    user_id: str = OWNER,
):
    """Build an ARS expense aggregate for a date, category and owner."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category=category,
        recurring=recurring,
        user_id=user_id,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _income(occurred_on: date, amount: str, kind: Kind = Kind.INCOME, *, user_id: str = OWNER):
    """Build an inflow (income or invoice) aggregate feeding savings."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Inflow",
        kind=kind,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Income",
        user_id=user_id,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _usd_invoice(occurred_on: date, usd: str, rate: str, created_at: datetime, *, user_id: str = OWNER):
    """Build a USD invoice carrying an applied rate (latest-USD input)."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="USD invoice",
        kind=Kind.INVOICE,
        amount=Decimal(usd) * Decimal(rate),
        currency=Currency.USD,
        usd_amount=Decimal(usd),
        fx_rate=Decimal(rate),
        fx_rate_type=FxRateType.MEP,
        category="Income",
        counts_toward_monotributo=True,
        user_id=user_id,
        created_at=created_at,
        updated_at=created_at,
    )


def _usd_expense(occurred_on: date, usd: str, rate: str, created_at: datetime):
    """Build a USD expense (e.g. a fee paid in dollars) with an applied rate.

    It carries a usd_amount + fx_rate like a USD invoice, but kind=expense — it
    must NOT be picked as the "latest invoice" insight (#26).
    """
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="USD fee",
        kind=Kind.EXPENSE,
        amount=Decimal(usd) * Decimal(rate),
        currency=Currency.USD,
        usd_amount=Decimal(usd),
        fx_rate=Decimal(rate),
        fx_rate_type=FxRateType.MEP,
        category="Fee",
        user_id=OWNER,
        created_at=created_at,
        updated_at=created_at,
    )


async def _seed(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist and commit the given aggregates through the repository."""
    async with session_factory() as session:
        repository = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repository.add(row)
        await session.commit()


class TestInsightsAggregation:
    """The reader derives the mover, recurring, savings and latest-USD facts."""

    async def test_past_month_facts_over_real_data(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN expenses across May and June, recurring expenses, inflow rows and a
              pair of USD invoices, with a reference in July (a past month)
        WHEN the June 2026 insights are read from PostgreSQL
        THEN the mover is the biggest positive month-over-month expense category,
             the recurring footprint sums the flagged rows, savings are the actual
             income minus expenses (not projected), and the latest USD invoice is
             the most recent one
        """
        # GIVEN
        rows = [
            # May 2026 — prior month for the mover delta.
            _expense(date(2026, 5, 10), "100.00", "Food"),
            _expense(date(2026, 5, 12), "400.00", "Rent"),
            # June 2026 — the requested month. Food doubled (+100%), Rent fell.
            _expense(date(2026, 6, 5), "200.00", "Food"),
            _expense(date(2026, 6, 6), "300.00", "Rent"),
            # Two recurring June expenses -> count 2, total 1500.
            _expense(date(2026, 6, 7), "500.00", "Subscriptions", recurring=True, name="Netflix"),
            _expense(date(2026, 6, 8), "1000.00", "Services", recurring=True, name="Gym"),
            # June inflow: income 5000 + invoice 3000 = 8000.
            _income(date(2026, 6, 2), "5000.00", Kind.INCOME),
            _income(date(2026, 6, 3), "3000.00", Kind.INVOICE),
            # Two USD invoices in June; the 20th is the latest.
            _usd_invoice(date(2026, 6, 15), "50.00", "1100.00", _MOMENT),
            _usd_invoice(date(2026, 6, 20), "100.00", "1200.00", _MOMENT),
        ]
        await _seed(session_factory, rows)

        # WHEN — reference in July makes June a past month: actual savings.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), OWNER)

        # THEN — month key.
        assert insights.month == "2026-06"

        # THEN — biggest positive mover: Food 100 -> 200 = +100%; Rent fell.
        assert insights.top_category_mover is not None
        assert insights.top_category_mover.category == "Food"
        assert insights.top_category_mover.delta_pct == Decimal("100")

        # THEN — recurring footprint: 2 rows summing 1500.
        assert insights.recurring is not None
        assert insights.recurring.count == 2
        assert insights.recurring.total == Decimal("1500.00")

        # THEN — savings: inflow (income + invoice kinds) minus expenses, actual.
        # Inflow = income 5000 + invoice 3000 + USD invoices (50*1100) + (100*1200) = 183000.
        # Expenses = 200 + 300 + 500 + 1000 = 2000 -> savings = 183000 - 2000 = 181000.
        assert insights.savings.is_projected is False
        assert insights.savings.elapsed_fraction == Decimal(1)
        assert insights.savings.amount == Decimal("181000.00")

        # THEN — latest USD invoice is the June 20th row.
        assert insights.latest_usd_invoice is not None
        assert insights.latest_usd_invoice.occurred_on == date(2026, 6, 20)
        assert insights.latest_usd_invoice.usd == Decimal("100.00")
        assert insights.latest_usd_invoice.rate == Decimal("1200.00")
        assert insights.latest_usd_invoice.rate_type == FxRateType.MEP.value

    async def test_latest_usd_invoice_ignores_usd_expenses(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD invoice and a MORE-RECENT USD expense (a fee paid in dollars)
        WHEN the latest-USD-invoice insight is read
        THEN it picks the invoice, not the later expense (#26 — a fee must not
             surface as a positive 'invoice')
        """
        # GIVEN — the fee is newer than the invoice but is an expense.
        rows = [
            _usd_invoice(date(2026, 6, 10), "100.00", "1200.00", _MOMENT),
            _usd_expense(date(2026, 6, 20), "30.00", "1200.00", _MOMENT),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            insights = await SqlAlchemyInsightsReader(session).monthly_insights(
                date(2026, 6, 1), date(2026, 7, 1), OWNER
            )

        # THEN — the invoice (10th), not the later fee expense (20th).
        assert insights.latest_usd_invoice is not None
        assert insights.latest_usd_invoice.occurred_on == date(2026, 6, 10)
        assert insights.latest_usd_invoice.usd == Decimal("100.00")

    async def test_current_month_savings_are_projected(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN inflow and expenses in the requested month with an explicit mid-month
              reference (the current month)
        WHEN the insights are read from PostgreSQL
        THEN savings are projected to month-end by the elapsed fraction and flagged
             projected
        """
        # GIVEN — June inflow 4000, expenses 1000 -> actual savings 3000.
        rows = [
            _income(date(2026, 6, 2), "4000.00", Kind.INCOME),
            _expense(date(2026, 6, 5), "1000.00", "Food"),
        ]
        await _seed(session_factory, rows)

        # WHEN — reference June 15th: June has 30 days -> fraction 15/30.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 6, 15), OWNER)

        # THEN — projected: 3000 / (15/30) = 6000.
        assert insights.savings.is_projected is True
        assert insights.savings.elapsed_fraction == Decimal(15) / Decimal(30)
        assert insights.savings.amount == Decimal("6000.00")

    async def test_empty_month_returns_none_facts_and_zero_savings(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a month with no transactions at all
        WHEN the insights are read from PostgreSQL
        THEN the optional facts are None and savings are 0
        """
        # WHEN — empty database, reference in a later month (actual savings).
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), OWNER)

        # THEN
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
        assert insights.savings.amount == Decimal("0")
        assert insights.savings.is_projected is False

    async def test_insights_are_scoped_to_the_caller(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one owner's expenses, recurring rows, inflow and a USD invoice in June
        WHEN a different owner (with no data) reads the June insights
        THEN every fact is empty/zero — never the first owner's rows (ADR-108)
        """
        # GIVEN — only OWNER has June activity.
        rows = [
            _expense(date(2026, 5, 10), "100.00", "Food", user_id=OWNER),
            _expense(date(2026, 6, 5), "200.00", "Food", user_id=OWNER),
            _expense(date(2026, 6, 7), "500.00", "Subscriptions", recurring=True, user_id=OWNER),
            _income(date(2026, 6, 2), "5000.00", Kind.INCOME, user_id=OWNER),
            _usd_invoice(date(2026, 6, 20), "100.00", "1200.00", _MOMENT, user_id=OWNER),
        ]
        await _seed(session_factory, rows)

        # WHEN — OTHER_OWNER reads their own (empty) insights.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), OTHER_OWNER)

        # THEN — no cross-tenant leakage.
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
        assert insights.savings.amount == Decimal("0")


# The card-due window is relative to "now"; anchor the reference so the window is
# deterministic and clock-independent regardless of when the suite runs.
_REF = date(2026, 6, 12)


async def _seed_account(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner: str,
    institution_type: InstitutionType,
    currency: Currency = Currency.ARS,
) -> UUID:
    """Persist an institution + account of ``institution_type`` for ``owner`` and return the account id."""
    async with session_factory() as session:
        institution = build_institution(name="Galicia", type=institution_type, user_id=owner)
        SqlAlchemyInstitutionRepository(session).add(institution)
        await session.flush()
        account = build_account(institution_id=institution.id, currency=currency, user_id=owner)
        SqlAlchemyAccountRepository(session).add(account)
        await session.commit()
        return account.id


def _card_charge(
    occurred_on: date,
    amount: str,
    account_id,
    *,
    currency: Currency = Currency.ARS,
    usd: str | None = None,
    user_id: str = OWNER,
):
    """Build an EXPENSE charge posted to a (card) account, dated on its due date (ADR-089)."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Card charge",
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=currency,
        usd_amount=Decimal(usd) if usd is not None else None,
        category="Shopping",
        account_id=account_id,
        user_id=user_id,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


class TestUpcomingCardDueAggregation:
    """The reader derives the near-term card dues from real CARD-account rows (ADR-089)."""

    async def test_window_card_type_and_grouping_over_real_data(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN CARD-account charges due today, in 2 days (ARS+USD same date) and in 5 days,
              a past-due card charge, and a NON-card (bank) charge due soon
        WHEN the June insights are read with a reference of the 12th
        THEN only the CARD charges within [today, today+3] surface, grouped by date with
             native per-currency totals and ordered ascending — the 5-day-out, past-due and
             bank rows are excluded (ADR-089)
        """
        # GIVEN — a CARD account and a BANK account for the same owner.
        card_account = await _seed_account(session_factory, owner=OWNER, institution_type=InstitutionType.CARD)
        card_usd_account = await _seed_account(
            session_factory, owner=OWNER, institution_type=InstitutionType.CARD, currency=Currency.USD
        )
        bank_account = await _seed_account(session_factory, owner=OWNER, institution_type=InstitutionType.BANK)
        due_soon = _REF + timedelta(days=2)
        await _seed(
            session_factory,
            [
                _card_charge(_REF, "50000.00", card_account),  # due today -> included
                _card_charge(due_soon, "80000.00", card_account),  # +2 days ARS -> included
                # +2 days USD: the ARS-equivalent amount is positive (write-time invariant),
                # but the USD-native usd_amount is what the due total sums (ADR-123).
                _card_charge(due_soon, "180000.00", card_usd_account, currency=Currency.USD, usd="150.00"),
                _card_charge(_REF + timedelta(days=5), "999.00", card_account),  # +5 days -> excluded
                _card_charge(_REF - timedelta(days=1), "111.00", card_account),  # past due -> excluded
                _card_charge(_REF, "222.00", bank_account),  # non-card -> excluded
            ],
        )

        # WHEN — reference (today) is the 12th.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), _REF, OWNER)

        # THEN — two due dates, ascending; the 12th ARS only, the 14th folding ARS + USD.
        assert insights.upcoming_card_due is not None
        assert [due.due_date for due in insights.upcoming_card_due] == [_REF, due_soon]
        today_due, soon_due = insights.upcoming_card_due
        assert today_due.ars == Decimal("50000.00")
        assert today_due.usd == Decimal("0")
        assert soon_due.ars == Decimal("80000.00")
        assert soon_due.usd == Decimal("150.00")

    async def test_no_upcoming_dues_yields_none(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a CARD account whose only charge is well outside the window
        WHEN the insights are read
        THEN the upcoming-card-due fact is None (nothing due soon)
        """
        # GIVEN
        card_account = await _seed_account(session_factory, owner=OWNER, institution_type=InstitutionType.CARD)
        await _seed(session_factory, [_card_charge(_REF + timedelta(days=30), "5000.00", card_account)])

        # WHEN
        async with session_factory() as session:
            insights = await SqlAlchemyInsightsReader(session).monthly_insights(date(2026, 6, 1), _REF, OWNER)

        # THEN
        assert insights.upcoming_card_due is None

    async def test_card_dues_are_scoped_to_the_caller(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one owner's CARD charge due today
        WHEN a DIFFERENT owner reads their insights
        THEN the foreign owner's card due never appears (ADR-108, ADR-130)
        """
        # GIVEN — only OWNER has a card account + a charge due today.
        card_account = await _seed_account(session_factory, owner=OWNER, institution_type=InstitutionType.CARD)
        await _seed(session_factory, [_card_charge(_REF, "50000.00", card_account, user_id=OWNER)])

        # WHEN — OTHER_OWNER reads their own (empty) insights.
        async with session_factory() as session:
            insights = await SqlAlchemyInsightsReader(session).monthly_insights(date(2026, 6, 1), _REF, OTHER_OWNER)

        # THEN — no cross-tenant leakage.
        assert insights.upcoming_card_due is None
