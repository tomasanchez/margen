"""The statement's ledger always closes on the hero, credits included (ADR-206, ADR-212, ADR-222).

A confirmed overpayment of an item or cuota leaves the person with a credit, which the due-only
outstanding (the hero) already nets. The outstanding-only ledger lists what is owed, so it
closes with a "Saldo a favor" row carrying that credit; the full history nets it through the
payment rows. These tests build the read models from real domain positions (as the reader does)
and check that the last running Saldo equals the hero in both modes.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from margen_api.domain.models.receivable import InstallmentPlan, ReceivableItem, build_receivable_item
from margen_api.domain.models.receivable_settlement import (
    NO_ALLOCATIONS,
    ItemAllocations,
    ItemPosition,
    assess_item,
    person_outstanding,
    person_upcoming,
)
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableInstallmentReadModel,
    ReceivableItemReadModel,
    ReceivablePaymentReadModel,
)
from margen_api.service_layer.receivable_statement import Locale, StatementView, build_statement_view

TODAY = date(2026, 11, 6)
PERSON = uuid4()


def _read_model(position: ItemPosition) -> ReceivableItemReadModel:
    """Project a domain position the way the reader does."""
    item = position.item
    return ReceivableItemReadModel(
        id=item.id,
        occurred_on=item.occurred_on,
        amount=item.amount,
        detail=item.detail,
        allocated=position.allocated,
        remaining=position.remaining,
        pardoned=position.pardoned,
        due_outstanding=position.due_outstanding,
        upcoming_total=position.upcoming_total,
        installments=tuple(
            ReceivableInstallmentReadModel(
                id=cuota.installment.id,
                index=cuota.installment.index,
                due_on=cuota.installment.due_on,
                amount=cuota.installment.amount,
                paid=cuota.paid,
                remaining=cuota.remaining,
                pardoned=cuota.installment.pardoned,
                status=cuota.status,
            )
            for cuota in position.installments
        ),
    )


def _views(positions: list[ItemPosition], payments: list[tuple[date, str]], lang: Locale = "en") -> list[StatementView]:
    """Build the outstanding-only and the full-history views for one person."""
    person = PersonDetailReadModel(
        id=PERSON,
        name="Juan",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        outstanding=person_outstanding(positions),
        items=tuple(_read_model(position) for position in positions),
        payments=tuple(ReceivablePaymentReadModel(occurred_on=day, amount=Decimal(amount)) for day, amount in payments),
        upcoming_total=person_upcoming(positions),
    )
    return [build_statement_view(person, lang=lang, full_history=full, today=TODAY) for full in (False, True)]


def _plan() -> ReceivableItem:
    """A 300 TV in 3 cuotas due Oct 1, Nov 1 (both due by Nov 6) and Dec 1 (upcoming)."""
    return build_receivable_item(
        person_id=PERSON,
        occurred_on=date(2026, 9, 1),
        amount=Decimal("300"),
        detail="TV",
        plan=InstallmentPlan(3, date(2026, 10, 1)),
    )


def _closing_balance(view: StatementView) -> str:
    """Return the Saldo of the last ledger row that moves the balance."""
    return [row.balance for row in view.ledger_rows if row.balance][-1]


class TestLedgerClosesOnTheHero:
    """The last running Saldo equals the hero balance in both modes."""

    def test_overpaid_due_cuota_shows_its_credit(self):
        """
        GIVEN cuota 1 (100, due) confirmed-overpaid with 300 and an open 500 dinner — 400 owed
        WHEN both statement modes are built
        THEN both close on 400: the outstanding-only ledger lists cuota 2 (100) and the dinner
             (500), then a "Credit in your favor" row of 200
        """
        # GIVEN
        plan = _plan()
        dinner = build_receivable_item(person_id=PERSON, occurred_on=date(2026, 10, 20), amount=Decimal("500"))
        first = plan.installments[0]
        positions = [
            assess_item(plan, ItemAllocations(total=Decimal("300"), by_installment={first.id: Decimal("300")}), TODAY),
            assess_item(dinner, NO_ALLOCATIONS, TODAY),
        ]

        # WHEN
        outstanding_only, full = _views(positions, [(date(2026, 10, 5), "300")])

        # THEN
        assert outstanding_only.balance_to_date_value == "400.00"
        assert _closing_balance(outstanding_only) == _closing_balance(full) == "400.00"
        credit = outstanding_only.ledger_rows[-1]
        assert (credit.detail, credit.amount, credit.is_payment) == ("Credit in your favor", "− 200.00", True)

    def test_overpaid_upcoming_cuota_is_a_credit_now(self):
        """
        GIVEN cuota 3 (100, not yet due) paid 250 ahead — cuotas 1-2 (200) due, a 150 credit
        WHEN both statement modes are built
        THEN both close on the hero of 50, the outstanding-only ledger through a 150 credit row
        """
        # GIVEN
        plan = _plan()
        third = plan.installments[2]
        positions = [
            assess_item(plan, ItemAllocations(total=Decimal("250"), by_installment={third.id: Decimal("250")}), TODAY)
        ]

        # WHEN
        outstanding_only, full = _views(positions, [(date(2026, 11, 1), "250")])

        # THEN
        assert outstanding_only.balance_to_date_value == "50.00"
        assert _closing_balance(outstanding_only) == _closing_balance(full) == "50.00"
        assert outstanding_only.ledger_rows[-1].amount == "− 150.00"
        assert outstanding_only.show_upcoming is False

    @pytest.mark.parametrize(
        ("lang", "label", "closing"), [("en", "Credit in your favor", "-200.00"), ("es", "Saldo a favor", "-200,00")]
    )
    def test_credit_alone_is_listed_instead_of_the_empty_state(self, lang: Locale, label: str, closing: str):
        """
        GIVEN a person who owes nothing and paid 200 beyond a 100 lunch
        WHEN the outstanding-only statement is built
        THEN its ledger is a single localized credit row closing on the negative hero, not the
             calm "nothing owed" empty state
        """
        # GIVEN
        lunch = build_receivable_item(person_id=PERSON, occurred_on=date(2026, 10, 1), amount=Decimal("100"))
        positions = [assess_item(lunch, ItemAllocations(total=Decimal("300")), TODAY)]

        # WHEN
        outstanding_only, _full = _views(positions, [(date(2026, 10, 2), "300")], lang=lang)

        # THEN
        assert [row.detail for row in outstanding_only.ledger_rows] == [label]
        assert _closing_balance(outstanding_only) == closing
