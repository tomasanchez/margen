"""Unit tests for the as-of receivable settlement policy (ADR-206, ADR-210, ADR-215, ADR-221).

Plain domain objects with an explicit ``as_of`` date — never the wall clock (ADR-223). They pin
the due/upcoming split (a cuota due ON the as-of date is due), the cuota status precedence
(pardoned > paid > due/upcoming), that a flat item keeps ADR-206's whole-remainder formula,
the person roll-ups, and the ADR-221 default allocation order: due cuotas oldest first, then
open flat items newest first, never an upcoming cuota.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.receivable import InstallmentPlan, ReceivableItem, build_receivable_item
from margen_api.domain.models.receivable_settlement import (
    NO_ALLOCATIONS,
    InstallmentStatus,
    ItemAllocations,
    TargetOverrun,
    assess_item,
    default_allocation,
    find_target_overrun,
    installment_status,
    person_outstanding,
    person_upcoming,
)

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
PERSON = uuid4()
# A 3 x 1000 plan due Jul 10, Aug 10 and Sep 10; "today" is Aug 10 for most scenarios.
FIRST_DUE = date(2026, 7, 10)
TODAY = date(2026, 8, 10)


def _plan_item(
    *,
    amount: str = "3000",
    count: int = 3,
    first_due_on: date = FIRST_DUE,
    occurred_on: date = date(2026, 7, 1),
    item_id: UUID | None = None,
) -> ReceivableItem:
    """Build an installment item for the settlement scenarios."""
    return build_receivable_item(
        item_id=item_id or uuid4(),
        person_id=PERSON,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        created_at=A_TIME,
        plan=InstallmentPlan(count=count, first_due_on=first_due_on),
    )


def _flat_item(
    amount: str,
    *,
    occurred_on: date = date(2026, 6, 1),
    pardoned: bool = False,
    item_id: UUID | None = None,
) -> ReceivableItem:
    """Build a flat item for the settlement scenarios."""
    return build_receivable_item(
        item_id=item_id or uuid4(),
        person_id=PERSON,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        created_at=A_TIME,
        pardoned_at=A_TIME if pardoned else None,
    )


def _paid(item: ReceivableItem, *amounts: str) -> ItemAllocations:
    """Allocations paying the item's cuotas in order (``amounts[i]`` toward cuota ``i + 1``)."""
    by_installment = {
        cuota.id: Decimal(amount) for cuota, amount in zip(item.installments, amounts, strict=False) if amount != "0"
    }
    return ItemAllocations(total=sum(by_installment.values(), Decimal(0)), by_installment=by_installment)


class TestInstallmentStatus:
    """Precedence: pardoned, then paid, then due vs. upcoming by due date (ADR-215, ADR-221)."""

    def test_status_precedence_and_boundary(self):
        """
        GIVEN cuotas in every state, one due exactly today
        WHEN each is classified as of today
        THEN pardoned wins over paid, paid over due, and due_on == today is due
        """
        # GIVEN
        item = _plan_item().set_installment_pardon(3, pardoned_at=A_TIME)
        first, second, third = item.installments

        # THEN
        assert installment_status(third, Decimal("1000"), TODAY) is InstallmentStatus.PARDONED
        assert installment_status(first, Decimal("0"), TODAY) is InstallmentStatus.PAID
        assert installment_status(second, Decimal("1000"), TODAY) is InstallmentStatus.DUE  # due Aug 10 == today
        assert installment_status(second, Decimal("1000"), date(2026, 8, 9)) is InstallmentStatus.UPCOMING


class TestAssessItem:
    """An item's position as of a date (ADR-206, ADR-215)."""

    def test_flat_item_counts_its_whole_remainder(self):
        """
        GIVEN a flat 1000 item with 400 allocated
        WHEN it is assessed (any date)
        THEN its whole 600 remainder is due outstanding and nothing is upcoming (ADR-206 unchanged)
        """
        position = assess_item(_flat_item("1000"), ItemAllocations(total=Decimal("400")), TODAY)
        assert position.allocated == Decimal("400")
        assert position.remaining == Decimal("600")
        assert position.due_outstanding == Decimal("600")
        assert position.upcoming_total == Decimal("0")
        assert position.installments == ()
        assert position.pardoned is False

    def test_pardoned_flat_item_owes_nothing_but_keeps_its_covered_remainder(self):
        """
        GIVEN a pardoned flat 1000 item
        WHEN it is assessed
        THEN it contributes nothing to outstanding but still reports its 1000 remainder (covered)
        """
        position = assess_item(_flat_item("1000", pardoned=True), NO_ALLOCATIONS, TODAY)
        assert position.due_outstanding == Decimal("0")
        assert position.remaining == Decimal("1000")
        assert position.pardoned is True

    def test_installment_item_counts_only_due_cuotas(self):
        """
        GIVEN a 3 x 1000 plan (Jul 10, Aug 10, Sep 10) with 400 paid toward cuota 1
        WHEN it is assessed as of Aug 10
        THEN cuotas 1-2 are due (600 + 1000 outstanding), cuota 3 is upcoming (1000), and the
             gross remaining is 2600
        """
        # GIVEN
        item = _plan_item()

        # WHEN
        position = assess_item(item, _paid(item, "400"), TODAY)

        # THEN
        assert position.due_outstanding == Decimal("1600")
        assert position.upcoming_total == Decimal("1000")
        assert position.remaining == Decimal("2600")
        assert [cuota.status for cuota in position.installments] == [
            InstallmentStatus.DUE,
            InstallmentStatus.DUE,
            InstallmentStatus.UPCOMING,
        ]
        assert [cuota.paid for cuota in position.installments] == [Decimal("400"), Decimal("0"), Decimal("0")]
        assert [cuota.remaining for cuota in position.installments] == [
            Decimal("600.00"),
            Decimal("1000.00"),
            Decimal("1000.00"),
        ]

    def test_pardoned_cuotas_count_nowhere(self):
        """
        GIVEN the plan with cuota 2 (due) and cuota 3 (upcoming) pardoned
        WHEN it is assessed as of Aug 10
        THEN only cuota 1 is outstanding and nothing is upcoming
        """
        item = _plan_item().set_installment_pardon(2, pardoned_at=A_TIME).set_installment_pardon(3, pardoned_at=A_TIME)
        position = assess_item(item, NO_ALLOCATIONS, TODAY)
        assert position.due_outstanding == Decimal("1000")
        assert position.upcoming_total == Decimal("0")
        assert position.pardoned is False  # cuota 1 is still due

    def test_paid_ahead_cuota_is_paid_not_upcoming(self):
        """
        GIVEN the plan with cuota 3 paid in full ahead of its due date
        WHEN it is assessed as of Aug 10
        THEN cuota 3 is 'paid' and adds nothing to upcoming
        """
        item = _plan_item()
        position = assess_item(item, _paid(item, "0", "0", "1000"), TODAY)
        assert position.installments[2].status is InstallmentStatus.PAID
        assert position.upcoming_total == Decimal("0")

    def test_fully_paid_or_forgiven_plan_reads_as_pardoned(self):
        """
        GIVEN a plan whose cuota 1 is paid and cuotas 2-3 are pardoned
        WHEN it is assessed
        THEN the item as a whole reads as pardoned (nothing left to collect, ADR-221)
        """
        item = _plan_item().set_pardon(pardoned=True, at=A_TIME, paid_by_installment={})
        item = item.set_installment_pardon(1, pardoned_at=None)
        position = assess_item(item, _paid(item, "1000"), TODAY)
        assert position.pardoned is True

    def test_untouched_plan_is_not_pardoned(self):
        """
        GIVEN a plan with every cuota paid and none pardoned
        WHEN it is assessed
        THEN it does not read as pardoned
        """
        item = _plan_item()
        assert assess_item(item, _paid(item, "1000", "1000", "1000"), TODAY).pardoned is False


class TestPersonTotals:
    """A person's outstanding is due-only; upcoming is reported apart (ADR-215)."""

    def test_person_outstanding_and_upcoming_sum_positions(self):
        """
        GIVEN a flat 500 item and the 3 x 1000 plan, nothing paid
        WHEN the person is assessed as of Aug 10
        THEN outstanding = 500 + 2000 due and upcoming = 1000
        """
        positions = [
            assess_item(_flat_item("500"), NO_ALLOCATIONS, TODAY),
            assess_item(_plan_item(), NO_ALLOCATIONS, TODAY),
        ]
        assert person_outstanding(positions) == Decimal("2500")
        assert person_upcoming(positions) == Decimal("1000")

    def test_allocation_existence(self):
        """
        GIVEN no allocations and some allocations
        WHEN existence is checked
        THEN only the latter exist
        """
        assert NO_ALLOCATIONS.exist is False
        assert ItemAllocations(total=Decimal("1")).exist is True


class TestDefaultAllocation:
    """Due cuotas oldest first, then open flat items newest first (ADR-221)."""

    def test_fills_due_cuotas_oldest_first_then_flat_items_newest_first(self):
        """
        GIVEN two plans (A bought Jul 1, B bought Jun 1, both due from Jul 10), an older and a
              newer open flat item, a pardoned flat item, a paid flat item and an upcoming cuota
        WHEN 5500 is spread as of Aug 10
        THEN due cuotas fill by due date (ties: the older purchase first), then the newest flat
             item, then the older one; upcoming, pardoned and paid targets are skipped
        """
        # GIVEN
        plan_a = _plan_item(occurred_on=date(2026, 7, 1))
        plan_b = _plan_item(occurred_on=date(2026, 6, 1), amount="2000", count=2)
        older_flat = _flat_item("300", occurred_on=date(2026, 5, 1))
        newer_flat = _flat_item("200", occurred_on=date(2026, 6, 15))
        positions = [
            assess_item(plan_a, NO_ALLOCATIONS, TODAY),
            assess_item(plan_b, _paid(plan_b, "250"), TODAY),
            assess_item(older_flat, NO_ALLOCATIONS, TODAY),
            assess_item(newer_flat, NO_ALLOCATIONS, TODAY),
            assess_item(_flat_item("900", pardoned=True), NO_ALLOCATIONS, TODAY),
            assess_item(_flat_item("100"), ItemAllocations(total=Decimal("100")), TODAY),
        ]

        # WHEN
        suggestion = default_allocation(positions, Decimal("5500"))

        # THEN — B's Jul cuota (older purchase) before A's Jul cuota, then Aug cuotas the same way.
        a1, a2, _a3 = plan_a.installments
        b1, b2 = plan_b.installments
        assert [(line.item_id, line.installment_id, line.amount) for line in suggestion.lines] == [
            (plan_b.id, b1.id, Decimal("750.00")),
            (plan_a.id, a1.id, Decimal("1000.00")),
            (plan_b.id, b2.id, Decimal("1000.00")),
            (plan_a.id, a2.id, Decimal("1000.00")),
            (newer_flat.id, None, Decimal("200")),
            (older_flat.id, None, Decimal("300")),
        ]
        assert suggestion.allocated == Decimal("4250.00")
        assert suggestion.unallocated == Decimal("1250.00")

    def test_stops_when_the_payment_runs_out(self):
        """
        GIVEN the 3 x 1000 plan with all three cuotas due (as of Sep 10)
        WHEN only 1500 is spread
        THEN cuota 1 takes 1000, cuota 2 the remaining 500, cuota 3 gets nothing, and nothing
             is left unallocated
        """
        item = _plan_item()
        suggestion = default_allocation([assess_item(item, NO_ALLOCATIONS, date(2026, 9, 10))], Decimal("1500"))
        assert [(line.installment_id, line.amount) for line in suggestion.lines] == [
            (item.installments[0].id, Decimal("1000.00")),
            (item.installments[1].id, Decimal("500.00")),
        ]
        assert suggestion.unallocated == Decimal("0")

    def test_nothing_due_leaves_everything_unallocated(self):
        """
        GIVEN a plan whose first cuota is not due yet
        WHEN a payment is spread
        THEN nothing is suggested (paying ahead is a manual choice)
        """
        item = _plan_item(first_due_on=date(2026, 9, 1))
        suggestion = default_allocation([assess_item(item, NO_ALLOCATIONS, TODAY)], Decimal("700"))
        assert suggestion.lines == ()
        assert suggestion.allocated == Decimal("0")
        assert suggestion.unallocated == Decimal("700")


class TestUpcomingCredit:
    """Upcoming is never negative: paying a later cuota beyond its amount is a credit (ADR-206, ADR-215)."""

    def test_overpaid_upcoming_cuota_lowers_outstanding_instead_of_upcoming(self):
        """
        GIVEN the 3 x 1000 plan as of Aug 10 (cuotas 1-2 due) with 1250 paid toward cuota 3
        WHEN it is assessed
        THEN cuota 3 is paid with a -250 remainder, upcoming is 0 and the 250 excess is a credit:
             outstanding is 2000 - 250 = 1750
        """
        # GIVEN
        item = _plan_item()

        # WHEN
        position = assess_item(item, _paid(item, "0", "0", "1250"), TODAY)

        # THEN
        assert position.installments[2].status is InstallmentStatus.PAID
        assert position.installments[2].remaining == Decimal("-250.00")
        assert position.upcoming_total == Decimal("0")
        assert position.due_outstanding == Decimal("1750.00")


class TestSuggestionCap:
    """The default allocation never suggests more than the person owes (ADR-206, ADR-221)."""

    def test_a_credit_elsewhere_caps_the_suggestion(self):
        """
        GIVEN a lunch overpaid by 100 (a credit) and the plan with 2000 due — 1900 owed overall
        WHEN 5000 is spread
        THEN only 1900 is suggested (cuota 1 in full, 900 of cuota 2), the rest is unallocated,
             so posting the suggestion back never trips the overpayment warning
        """
        # GIVEN
        lunch = _flat_item("100")
        plan = _plan_item()
        positions = [
            assess_item(lunch, ItemAllocations(total=Decimal("200")), TODAY),
            assess_item(plan, NO_ALLOCATIONS, TODAY),
        ]

        # WHEN
        suggestion = default_allocation(positions, Decimal("5000"))

        # THEN
        assert [line.amount for line in suggestion.lines] == [Decimal("1000.00"), Decimal("900.00")]
        assert suggestion.allocated == person_outstanding(positions) == Decimal("1900.00")
        assert suggestion.unallocated == Decimal("3100.00")

    def test_a_person_in_credit_gets_no_suggestion(self):
        """
        GIVEN a person whose only item is overpaid (outstanding below zero)
        WHEN a payment is spread
        THEN nothing is suggested and the whole amount stays unallocated
        """
        positions = [assess_item(_flat_item("100"), ItemAllocations(total=Decimal("300")), TODAY)]
        suggestion = default_allocation(positions, Decimal("50"))
        assert suggestion.lines == ()
        assert suggestion.unallocated == Decimal("50")


class TestTargetOverrun:
    """An allocation beyond what its item or cuota owes is spotted per target (ADR-206, ADR-221)."""

    def _positions(self):
        """The 3 x 1000 plan and a flat 500 item, nothing paid, as of Aug 10."""
        plan = _plan_item()
        flat = _flat_item("500")
        return (
            plan,
            flat,
            {
                plan.id: assess_item(plan, NO_ALLOCATIONS, TODAY),
                flat.id: assess_item(flat, NO_ALLOCATIONS, TODAY),
            },
        )

    def test_reports_the_first_target_paid_beyond_what_it_owes(self):
        """
        GIVEN slices of 900 to cuota 2 (owes 1000) and 600 to the flat item (owes 500)
        WHEN overruns are looked for
        THEN the flat item is reported with its 500 remaining and the 600 requested
        """
        plan, flat, positions = self._positions()
        requested: dict[tuple[UUID, UUID | None], Decimal] = {
            (plan.id, plan.installments[1].id): Decimal("900"),
            (flat.id, None): Decimal("600"),
        }
        assert find_target_overrun(positions, requested) == TargetOverrun(flat.id, None, Decimal("500"), Decimal("600"))

    def test_a_cuota_is_compared_on_its_own_remainder(self):
        """
        GIVEN 1200 requested of cuota 1 (owes 1000) while the person owes 2500 overall
        WHEN overruns are looked for
        THEN cuota 1 is reported, even though the person-level total would pass
        """
        plan, _flat, positions = self._positions()
        first = plan.installments[0].id
        overrun = find_target_overrun(positions, {(plan.id, first): Decimal("1200")})
        assert overrun == TargetOverrun(plan.id, first, Decimal("1000.00"), Decimal("1200"))

    def test_none_when_every_target_absorbs_its_share(self):
        """
        GIVEN slices within each target's remainder
        WHEN overruns are looked for
        THEN there is none
        """
        plan, flat, positions = self._positions()
        requested: dict[tuple[UUID, UUID | None], Decimal] = {
            (plan.id, plan.installments[2].id): Decimal("1000"),
            (flat.id, None): Decimal("500"),
        }
        assert find_target_overrun(positions, requested) is None
