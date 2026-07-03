"""Integration tests for the net-worth liabilities reservation against real PostgreSQL (ADR-180, ADR-181).

Marked ``integration`` (ADR-032): these run only when a real PostgreSQL is reachable and
are excluded from the coverage gate. They prove the instalment-liability SQL - the
``(name, category)`` collapse to each plan's LATEST occurrence, the remaining-count tail
(``total - index``), the MEP conversion of a USD tail, the exclusion of subscriptions from
the reservation, and owner scoping - actually work end to end, which the pure-function and
mocked tiers cannot verify. The assets-only ``total`` is confirmed unchanged (ADR-122/180).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.account_queries import SqlAlchemyAccountReader
from margen_api.adapters.account_repository import SqlAlchemyAccountRepository
from margen_api.adapters.institution_repository import SqlAlchemyInstitutionRepository
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.account import build_account
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind, RecurringCadence

pytestmark = pytest.mark.integration

# Two distinct owners prove the reservation is scoped to the caller (ADR-130).
OWNER = "77777777-7777-4777-8777-777777777777"
OTHER_OWNER = "88888888-8888-4888-8888-888888888888"

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)
_A_DATE = date(2026, 6, 12)

# Net worth is an as-of-today snapshot (ADR-186): a future-dated card charge is a
# ccBalance liability, a past one has already left the account. Relative to now so the
# integration tier never time-bombs.
_TODAY = datetime.now(UTC).date()
_FUTURE = _TODAY + timedelta(days=30)
_PAST = _TODAY - timedelta(days=30)


def _tx(**overrides: object):
    """Build an EXPENSE transaction with sensible defaults for the liability streams."""
    defaults: dict[str, object] = {
        "transaction_id": uuid4(),
        "occurred_on": _A_DATE,
        "name": "Movement",
        "kind": Kind.EXPENSE,
        "amount": Decimal("500"),
        "user_id": OWNER,
        "created_at": _MOMENT,
        "updated_at": _MOMENT,
    }
    defaults.update(overrides)
    return build_transaction(**defaults)  # type: ignore[arg-type]


async def _seed_account(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner: str,
    currency: Currency = Currency.ARS,
    opening_balance: Decimal = Decimal("0"),
    institution_type: InstitutionType = InstitutionType.BANK,
):
    """Persist an institution + account for ``owner`` and return the account id."""
    async with session_factory() as session:
        institution = build_institution(name="Galicia", type=institution_type, user_id=owner)
        SqlAlchemyInstitutionRepository(session).add(institution)
        # Flush the institution first so the account's FK to it is satisfied on real PG.
        await session.flush()
        account = build_account(
            institution_id=institution.id, currency=currency, opening_balance=opening_balance, user_id=owner
        )
        SqlAlchemyAccountRepository(session).add(account)
        await session.commit()
        return account.id


async def _seed_transactions(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist the given transaction aggregates in one committed session."""
    async with session_factory() as session:
        repo = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repo.add(row)
        await session.commit()


class TestNetWorthLiabilitiesSql:
    """The reader derives the instalment tail liability from real rows (ADR-180, ADR-181)."""

    async def test_installment_tail_reduces_net_after_liabilities(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN an ARS account and an active instalment plan (cuota 2 of 6 -> 4 remaining)
        WHEN net worth is read from PostgreSQL
        THEN total is assets-only, liabilities.installments = 4 x cuota, and
             net_after_liabilities = total - tail (ADR-180, ADR-181)
        """
        # GIVEN — opening 100000; one instalment cuota (500, 4 remaining) posted to the account.
        account_id = await _seed_account(session_factory, owner=OWNER, opening_balance=Decimal("100000"))
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="Fridge",
                    category="Home",
                    amount=Decimal("500"),
                    account_id=account_id,
                    recurring_cadence=RecurringCadence.INSTALLMENT,
                    installments_total=6,
                    installments_index=2,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — the cuota reduces the balance (100000 - 500 = 99500); the tail is 4 x 500 = 2000.
        assert net_worth.total == Decimal("99500.00")
        assert net_worth.liabilities.installments == Decimal("2000.00")
        assert net_worth.liabilities.total == Decimal("2000.00")
        # No CC balance for this owner: a computed zero, not a placeholder (ADR-185).
        assert net_worth.liabilities.cc_balance == Decimal("0.00")
        # The native breakdown carries the unconverted ARS tail (no USD stream), ADR-183.
        assert net_worth.liabilities.installments_native.ars == Decimal("2000.00")
        assert net_worth.liabilities.installments_native.usd == Decimal("0.00")
        assert net_worth.net_after_liabilities == Decimal("97500.00")

    async def test_subscriptions_do_not_contribute(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a recurring subscription (NOT an instalment)
        WHEN net worth is read
        THEN it does not enter the liabilities reservation (ADR-182)
        """
        # GIVEN
        account_id = await _seed_account(session_factory, owner=OWNER, opening_balance=Decimal("50000"))
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="Netflix",
                    category="Subscriptions",
                    amount=Decimal("1000"),
                    account_id=account_id,
                    recurring=True,
                    recurring_cadence=RecurringCadence.MONTHLY,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN
        assert net_worth.liabilities.installments == Decimal("0.00")
        assert net_worth.net_after_liabilities == net_worth.total

    async def test_usd_tail_converts_via_mep_rate(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD instalment plan (cuota 10 USD, 3 remaining) and a captured MEP rate
        WHEN net worth is read in the ARS display currency
        THEN the USD tail is converted at the MEP rate (ADR-183)
        """
        # GIVEN — a USD account holding a USD instalment cuota with a 1000 ARS/USD snapshot.
        account_id = await _seed_account(
            session_factory, owner=OWNER, currency=Currency.USD, opening_balance=Decimal("0")
        )
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="Laptop",
                    category="Tech",
                    amount=Decimal("10000"),
                    currency=Currency.USD,
                    usd_amount=Decimal("10"),
                    fx_rate=Decimal("1000"),
                    fx_source="mep",
                    account_id=account_id,
                    recurring_cadence=RecurringCadence.INSTALLMENT,
                    installments_total=6,
                    installments_index=3,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — 3 remaining x 10 USD = 30 USD; at 1000 ARS/USD = 30,000 ARS.
        assert net_worth.currency is Currency.ARS
        assert net_worth.liabilities.installments == Decimal("30000.00")
        # The native breakdown carries the unconverted 30 USD tail (no ARS stream), ADR-183.
        assert net_worth.liabilities.installments_native.usd == Decimal("30.00")
        assert net_worth.liabilities.installments_native.ars == Decimal("0.00")

    async def test_reservation_is_owner_scoped(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN owner A has an active instalment plan
        WHEN owner B's net worth is read
        THEN B's reservation is zero - A's tail never leaks (ADR-108, ADR-130)
        """
        # GIVEN — A has an instalment plan; B has a plain account.
        a_account = await _seed_account(session_factory, owner=OWNER, opening_balance=Decimal("0"))
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="A plan",
                    category="Home",
                    amount=Decimal("500"),
                    account_id=a_account,
                    recurring_cadence=RecurringCadence.INSTALLMENT,
                    installments_total=6,
                    installments_index=1,
                )
            ],
        )
        await _seed_account(session_factory, owner=OTHER_OWNER, opening_balance=Decimal("10000"))

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OTHER_OWNER)

        # THEN
        assert net_worth.liabilities.installments == Decimal("0.00")
        assert net_worth.total == Decimal("10000.00")


class TestCcBalanceLiabilitySql:
    """The reader derives the unpaid CC balance from real rows and counts each peso once (ADR-185, ADR-186)."""

    async def test_future_card_charge_is_cc_balance_and_not_a_double_counted_asset(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a CARD account with a future-dated (not-yet-due) charge
        WHEN net worth is read from PostgreSQL
        THEN the charge is the ccBalance liability, does NOT reduce the as-of-today asset
             total, and net_after_liabilities counts it exactly ONCE (ADR-185, ADR-186)
        """
        # GIVEN — a card account opened at 0; a 3641.66 ARS charge dated in the future.
        account_id = await _seed_account(
            session_factory, owner=OWNER, opening_balance=Decimal("0"), institution_type=InstitutionType.CARD
        )
        await _seed_transactions(
            session_factory,
            [_tx(name="MERPAGO*PASSLINE", amount=Decimal("3641.66"), occurred_on=_FUTURE, account_id=account_id)],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — the future charge stays OUT of the asset total (as-of-today).
        assert net_worth.total == Decimal("0.00")
        assert net_worth.accounts[0].balance == Decimal("0.00")
        # AND — it is the ccBalance liability, native and converted.
        assert net_worth.liabilities.cc_balance == Decimal("3641.66")
        assert net_worth.liabilities.cc_balance_native.ars == Decimal("3641.66")
        assert net_worth.liabilities.total == Decimal("3641.66")
        # AND — counted ONCE: 0 assets - 3641.66 liability.
        assert net_worth.net_after_liabilities == Decimal("-3641.66")

    async def test_past_card_charge_is_a_paid_asset_reduction_not_a_liability(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a CARD account with a PAST-dated (already-due) charge
        WHEN net worth is read
        THEN the charge has reduced the asset balance and is NOT in ccBalance (ADR-089/185)
        """
        # GIVEN — a card account opened at 5000; a 1000 ARS charge dated in the past.
        account_id = await _seed_account(
            session_factory, owner=OWNER, opening_balance=Decimal("5000"), institution_type=InstitutionType.CARD
        )
        await _seed_transactions(
            session_factory,
            [_tx(name="Old charge", amount=Decimal("1000"), occurred_on=_PAST, account_id=account_id)],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — the past charge reduced the balance (5000 - 1000 = 4000); no ccBalance.
        assert net_worth.accounts[0].balance == Decimal("4000.00")
        assert net_worth.liabilities.cc_balance == Decimal("0.00")
        assert net_worth.net_after_liabilities == net_worth.total == Decimal("4000.00")

    async def test_installment_on_card_is_excluded_from_cc_balance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a future-dated instalment cuota on a CARD account
        WHEN net worth is read
        THEN it counts only as the instalment tail, NOT the ccBalance (ADR-181/185)
        """
        # GIVEN — a card account; a future instalment cuota (2 of 6, 4 remaining).
        account_id = await _seed_account(
            session_factory, owner=OWNER, opening_balance=Decimal("0"), institution_type=InstitutionType.CARD
        )
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="Fridge",
                    category="Home",
                    amount=Decimal("500"),
                    occurred_on=_FUTURE,
                    account_id=account_id,
                    recurring_cadence=RecurringCadence.INSTALLMENT,
                    installments_total=6,
                    installments_index=2,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — the instalment enters the tail (4 x 500 = 2000), NOT the ccBalance.
        assert net_worth.liabilities.installments == Decimal("2000.00")
        assert net_worth.liabilities.cc_balance == Decimal("0.00")

    async def test_future_charge_on_bank_account_is_not_a_cc_balance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a future-dated charge on a BANK (non-card) account
        WHEN net worth is read
        THEN it is not a ccBalance (only CARD accounts carry one) (ADR-185)
        """
        # GIVEN — a BANK account with a future-dated expense.
        account_id = await _seed_account(
            session_factory, owner=OWNER, opening_balance=Decimal("0"), institution_type=InstitutionType.BANK
        )
        await _seed_transactions(
            session_factory,
            [_tx(name="Future bank debit", amount=Decimal("800"), occurred_on=_FUTURE, account_id=account_id)],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — no ccBalance; the future charge is simply not-yet-counted.
        assert net_worth.liabilities.cc_balance == Decimal("0.00")
        assert net_worth.accounts[0].balance == Decimal("0.00")

    async def test_usd_card_balance_converts_at_mep_and_keeps_native(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a USD CARD account with a future-dated USD charge carrying a MEP rate
        WHEN net worth is read in ARS
        THEN ccBalance converts at MEP while cc_balance_native.usd stays unconverted (ADR-183/185)
        """
        # GIVEN — a USD card account; a future 100 USD charge at 1000 ARS/USD.
        account_id = await _seed_account(
            session_factory,
            owner=OWNER,
            currency=Currency.USD,
            opening_balance=Decimal("0"),
            institution_type=InstitutionType.CARD,
        )
        await _seed_transactions(
            session_factory,
            [
                _tx(
                    name="Apple Store",
                    amount=Decimal("100000"),
                    currency=Currency.USD,
                    usd_amount=Decimal("100"),
                    fx_rate=Decimal("1000"),
                    fx_source="mep",
                    occurred_on=_FUTURE,
                    account_id=account_id,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OWNER)

        # THEN — 100 USD at 1000 ARS/USD = 100,000 ARS; native keeps the raw 100 USD.
        assert net_worth.currency is Currency.ARS
        assert net_worth.liabilities.cc_balance == Decimal("100000.00")
        assert net_worth.liabilities.cc_balance_native.usd == Decimal("100.00")
        assert net_worth.liabilities.cc_balance_native.ars == Decimal("0.00")

    async def test_cc_balance_is_owner_scoped(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN owner A has a future-dated card charge
        WHEN owner B's net worth is read
        THEN B's ccBalance is zero — A's balance never leaks (ADR-108, ADR-130)
        """
        # GIVEN — A has a future card charge; B has a plain account.
        a_account = await _seed_account(
            session_factory, owner=OWNER, opening_balance=Decimal("0"), institution_type=InstitutionType.CARD
        )
        await _seed_transactions(
            session_factory,
            [_tx(name="A card charge", amount=Decimal("9999"), occurred_on=_FUTURE, account_id=a_account)],
        )
        await _seed_account(session_factory, owner=OTHER_OWNER, opening_balance=Decimal("10000"))

        # WHEN
        async with session_factory() as session:
            net_worth = await SqlAlchemyAccountReader(session).net_worth(OTHER_OWNER)

        # THEN
        assert net_worth.liabilities.cc_balance == Decimal("0.00")
        assert net_worth.total == Decimal("10000.00")
