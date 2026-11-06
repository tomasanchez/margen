"""Unit tests for receivable installment schedules (ADR-214, ADR-216, ADR-221).

Plain domain objects only — no database, no clock reads (every date is explicit). They pin the
schedule builder (even split with the rounding remainder on the LAST cuota, monthly due dates
clamped to month end), the installment-item invariants (sum == item amount, indexes 1..N, no
item-level pardon), the per-cuota edit/pardon behavior, the whole-plan pardon, the plan
revision rules with their allocation/pardon lock, and the mixed-mode allocation targeting.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.receivable import (
    EditReceivableItem,
    InstallmentAdjustmentInput,
    InstallmentPlanInput,
    NewInstallmentPlanInput,
)
from margen_api.domain.models.exceptions import (
    LOCKED_BY_ALLOCATIONS,
    LOCKED_BY_PARDONS,
    InstallmentAllocationTargetError,
    InstallmentAmountBelowPaidError,
    InstallmentScheduleLockedError,
    InvalidAmountError,
    InvalidInstallmentScheduleError,
    ReceivableInstallmentNotFoundError,
    ReceivableItemNotFoundError,
)
from margen_api.domain.models.receivable import (
    InstallmentAdjustment,
    InstallmentPlan,
    ReceivableInstallment,
    ReceivableItem,
    build_installment_schedule,
    build_receivable_allocation,
    build_receivable_item,
    monthly_due_date,
    split_evenly,
)

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
LATER = datetime(2026, 2, 1, tzinfo=UTC)
A_DATE = date(2026, 8, 1)
FIRST_DUE = date(2026, 9, 10)


def _installment_item(
    amount: str = "1000",
    count: int = 3,
    first_due_on: date = FIRST_DUE,
) -> ReceivableItem:
    """Build an installment item through the factory, like the add-item handler does."""
    return build_receivable_item(
        item_id=uuid4(),
        person_id=uuid4(),
        occurred_on=A_DATE,
        amount=Decimal(amount),
        created_at=A_TIME,
        plan=InstallmentPlan(count=count, first_due_on=first_due_on),
    )


def _flat_item(amount: str = "1000", *, pardoned_at: datetime | None = None) -> ReceivableItem:
    """Build a flat item (no cuotas)."""
    return build_receivable_item(
        item_id=uuid4(),
        person_id=uuid4(),
        occurred_on=A_DATE,
        amount=Decimal(amount),
        created_at=A_TIME,
        pardoned_at=pardoned_at,
    )


def _cuota(item_id: UUID, index: int, amount: str) -> ReceivableInstallment:
    """Build one raw cuota for invariant tests."""
    return ReceivableInstallment(
        id=uuid4(),
        item_id=item_id,
        index=index,
        due_on=monthly_due_date(FIRST_DUE, index - 1),
        amount=Decimal(amount),
    )


class TestSplitEvenly:
    """The even split puts the cents remainder on the LAST cuota (ADR-216)."""

    @pytest.mark.parametrize(
        ("total", "count", "expected"),
        [
            ("1200.00", 3, ["400.00", "400.00", "400.00"]),
            ("1000.00", 3, ["333.33", "333.33", "333.34"]),
            ("100.00", 6, ["16.66", "16.66", "16.66", "16.66", "16.66", "16.70"]),
            ("0.05", 2, ["0.02", "0.03"]),
        ],
    )
    def test_shares_sum_to_total_with_remainder_last(self, total: str, count: int, expected: list[str]):
        """
        GIVEN a cents total and a cuota count
        WHEN it is split evenly
        THEN every share but the last is the rounded-down quotient, the last absorbs the
             remainder, and the shares sum to the total exactly
        """
        # WHEN
        shares = split_evenly(Decimal(total), count)

        # THEN
        assert [str(share) for share in shares] == expected
        assert sum(shares, Decimal(0)) == Decimal(total)


class TestMonthlyDueDate:
    """Cuotas fall due monthly on the first cuota's day, clamped to month end (ADR-216)."""

    @pytest.mark.parametrize(
        ("first", "offset", "expected"),
        [
            (date(2026, 1, 15), 0, date(2026, 1, 15)),
            (date(2026, 11, 15), 2, date(2027, 1, 15)),
            (date(2027, 1, 31), 1, date(2027, 2, 28)),
            (date(2028, 1, 31), 1, date(2028, 2, 29)),
            (date(2027, 1, 31), 2, date(2027, 3, 31)),
            (date(2027, 1, 31), 3, date(2027, 4, 30)),
        ],
    )
    def test_same_day_of_month_clamped(self, first: date, offset: int, expected: date):
        """
        GIVEN the first cuota's due date and an offset in months
        WHEN the due date is derived
        THEN it keeps the day of month, rolls the year, and clamps to the month's last day
             without the clamp accumulating (Jan 31 -> Feb 28 -> Mar 31)
        """
        assert monthly_due_date(first, offset) == expected


class TestBuildInstallmentSchedule:
    """The schedule builder derives cuotas from a plan and the item total (ADR-214, ADR-216)."""

    def test_builds_indexed_monthly_cuotas_summing_to_the_total(self):
        """
        GIVEN a 1000 total split into 3 cuotas from Sept 10
        WHEN the schedule is built
        THEN cuotas 1..3 fall due monthly, split 333.33/333.33/333.34, owned by the item, with
             the injected ids and timestamp
        """
        # GIVEN
        item_id = uuid4()
        ids = iter([uuid4(), uuid4(), uuid4()])
        expected_ids = []

        def next_id() -> UUID:
            new_id = next(ids)
            expected_ids.append(new_id)
            return new_id

        # WHEN
        schedule = build_installment_schedule(
            item_id=item_id,
            total=Decimal("1000"),
            plan=InstallmentPlan(count=3, first_due_on=FIRST_DUE),
            created_at=A_TIME,
            new_id=next_id,
        )

        # THEN
        assert [cuota.index for cuota in schedule] == [1, 2, 3]
        assert [cuota.due_on for cuota in schedule] == [date(2026, 9, 10), date(2026, 10, 10), date(2026, 11, 10)]
        assert [cuota.amount for cuota in schedule] == [Decimal("333.33"), Decimal("333.33"), Decimal("333.34")]
        assert [cuota.id for cuota in schedule] == expected_ids
        assert all(cuota.item_id == item_id and cuota.created_at == A_TIME for cuota in schedule)
        assert all(cuota.pardoned is False for cuota in schedule)

    def test_total_is_normalized_half_up_to_cents(self):
        """
        GIVEN a total with sub-cent precision
        WHEN the schedule is built
        THEN the total is rounded half-up to cents before the split
        """
        # WHEN
        schedule = build_installment_schedule(
            item_id=uuid4(),
            total=Decimal("100.005"),
            plan=InstallmentPlan(count=2, first_due_on=FIRST_DUE),
        )

        # THEN — 100.01 split into 50.00 + 50.01; the timestamp defaults to now.
        assert [cuota.amount for cuota in schedule] == [Decimal("50.00"), Decimal("50.01")]
        assert all(isinstance(cuota.created_at, datetime) for cuota in schedule)

    def test_total_too_small_for_the_count_is_rejected(self):
        """
        GIVEN a total of 0.02 and a 3-cuota plan (not one cent per cuota)
        WHEN the schedule is built
        THEN InvalidInstallmentScheduleError is raised
        """
        with pytest.raises(InvalidInstallmentScheduleError, match="cannot be split"):
            build_installment_schedule(
                item_id=uuid4(),
                total=Decimal("0.02"),
                plan=InstallmentPlan(count=3, first_due_on=FIRST_DUE),
            )


class TestInstallmentPlan:
    """A plan needs at least two cuotas (ADR-216)."""

    @pytest.mark.parametrize("count", [1, 0])
    def test_fewer_than_two_cuotas_is_rejected(self, count: int):
        """
        GIVEN a plan of fewer than two cuotas
        WHEN it is built
        THEN InvalidInstallmentScheduleError is raised (a single cuota is just a flat item)
        """
        with pytest.raises(InvalidInstallmentScheduleError, match="at least 2"):
            InstallmentPlan(count=count, first_due_on=FIRST_DUE)

    def test_command_input_translates_to_the_domain_plan(self):
        """
        GIVEN the command's nested plan input
        WHEN it is translated
        THEN the domain plan carries the same count and first due date
        """
        assert InstallmentPlanInput(count=4, first_due_on=FIRST_DUE).to_plan() == InstallmentPlan(4, FIRST_DUE)


class TestReceivableInstallment:
    """A cuota is a positive cents magnitude with a 1-based index (ADR-214)."""

    def test_amount_is_coerced_and_quantized_to_cents(self):
        """
        GIVEN a cuota built from a string amount with sub-cent precision
        WHEN it is constructed
        THEN the amount becomes a Decimal rounded half-up to cents
        """
        cuota = ReceivableInstallment(id=uuid4(), item_id=uuid4(), index=1, due_on=FIRST_DUE, amount="10.005")  # type: ignore[arg-type]
        assert cuota.amount == Decimal("10.01")

    @pytest.mark.parametrize("amount", ["0", "0.004", "-5"])
    def test_non_positive_cents_amount_is_rejected(self, amount: str):
        """
        GIVEN a cuota amount that is not a positive cents magnitude
        WHEN it is constructed
        THEN InvalidAmountError is raised
        """
        with pytest.raises(InvalidAmountError):
            ReceivableInstallment(id=uuid4(), item_id=uuid4(), index=1, due_on=FIRST_DUE, amount=Decimal(amount))

    def test_index_starts_at_one(self):
        """
        GIVEN a cuota index of 0
        WHEN it is constructed
        THEN InvalidInstallmentScheduleError is raised
        """
        with pytest.raises(InvalidInstallmentScheduleError, match="starts at 1"):
            ReceivableInstallment(id=uuid4(), item_id=uuid4(), index=0, due_on=FIRST_DUE, amount=Decimal("1"))


class TestInstallmentItemInvariants:
    """An installment item's schedule always matches the item (ADR-214, ADR-216, ADR-221)."""

    def test_factory_derives_the_amount_from_the_schedule(self):
        """
        GIVEN an item created with a 3-cuota plan for 1000.004
        WHEN it is built
        THEN it carries the schedule, its amount is the schedule's exact sum, and its plan reads back
        """
        # WHEN
        item = _installment_item(amount="1000.004")

        # THEN
        assert item.has_schedule is True
        assert item.amount == Decimal("1000.00")
        assert item.plan == InstallmentPlan(count=3, first_due_on=FIRST_DUE)

    def test_flat_item_has_no_schedule_or_plan(self):
        """
        GIVEN a flat item
        WHEN its schedule state is read
        THEN it has no schedule and no plan
        """
        item = _flat_item()
        assert item.has_schedule is False
        assert item.plan is None
        assert item.installments == ()

    def test_cuotas_are_ordered_by_index(self):
        """
        GIVEN cuotas supplied out of order
        WHEN the item is constructed
        THEN they are stored ordered by index
        """
        item_id = uuid4()
        cuotas = (_cuota(item_id, 2, "500"), _cuota(item_id, 1, "500"))
        item = ReceivableItem(
            id=item_id, person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("1000"), installments=cuotas
        )
        assert [cuota.index for cuota in item.installments] == [1, 2]

    @pytest.mark.parametrize(
        ("indexes", "amounts", "item_amount", "foreign", "pardoned", "message"),
        [
            ([1], ["1000"], "1000", False, False, "at least 2"),
            ([1, 3], ["500", "500"], "1000", False, False, "1..N"),
            ([1, 1], ["500", "500"], "1000", False, False, "1..N"),
            ([1, 2], ["500", "500"], "1000", True, False, "belong to the item"),
            ([1, 2], ["500", "400"], "1000", False, False, "sum to the item amount"),
            ([1, 2], ["500", "500"], "1000", False, True, "pardoned through its cuotas"),
        ],
    )
    def test_broken_schedules_are_rejected(
        self,
        indexes: list[int],
        amounts: list[str],
        item_amount: str,
        foreign: bool,
        pardoned: bool,
        message: str,
    ):
        """
        GIVEN a schedule that breaks one installment-item invariant
        WHEN the item is constructed
        THEN InvalidInstallmentScheduleError names the broken rule
        """
        # GIVEN
        item_id = uuid4()
        owner = uuid4() if foreign else item_id
        cuotas = tuple(_cuota(owner, index, amount) for index, amount in zip(indexes, amounts, strict=True))

        # WHEN / THEN
        with pytest.raises(InvalidInstallmentScheduleError, match=message):
            ReceivableItem(
                id=item_id,
                person_id=uuid4(),
                occurred_on=A_DATE,
                amount=Decimal(item_amount),
                pardoned_at=A_TIME if pardoned else None,
                installments=cuotas,
            )


class TestEditInstallment:
    """A single cuota can be edited; the item amount is re-derived (ADR-216)."""

    def test_amount_edit_rederives_the_item_amount_and_keeps_identity(self):
        """
        GIVEN a 3 x 333.33/333.34 installment item
        WHEN cuota 3 gets a recargo (500)
        THEN only that cuota changes, it keeps its id, and the item amount becomes 1166.66
        """
        # GIVEN
        item = _installment_item()
        third = item.installments[2]

        # WHEN
        edited = item.edit_installment(3, amount=Decimal("500"), paid_by_installment={})

        # THEN
        assert edited.amount == Decimal("1166.66")
        assert edited.installments[2].id == third.id
        assert edited.installments[2].amount == Decimal("500.00")
        assert edited.installments[2].due_on == third.due_on
        assert edited.installments[:2] == item.installments[:2]

    def test_due_date_edit_keeps_the_amount(self):
        """
        GIVEN an installment item
        WHEN cuota 2's due date is postponed
        THEN its due date changes and the item amount stays the same
        """
        # GIVEN
        item = _installment_item()

        # WHEN
        edited = item.edit_installment(2, due_on=date(2027, 1, 5), paid_by_installment={})

        # THEN
        assert edited.installments[1].due_on == date(2027, 1, 5)
        assert edited.amount == item.amount

    def test_unknown_index_is_not_found(self):
        """
        GIVEN an installment item with 3 cuotas, and a flat item
        WHEN cuota 4 (or any cuota of the flat item) is edited
        THEN ReceivableInstallmentNotFoundError is raised
        """
        with pytest.raises(ReceivableInstallmentNotFoundError):
            _installment_item().edit_installment(4, amount=Decimal("1"), paid_by_installment={})
        with pytest.raises(ReceivableInstallmentNotFoundError):
            _flat_item().edit_installment(1, amount=Decimal("1"), paid_by_installment={})


class TestPardon:
    """Pardon targets a cuota, or the whole remaining plan of an installment item (ADR-210, ADR-221)."""

    def test_single_cuota_pardon_and_unpardon(self):
        """
        GIVEN an installment item
        WHEN cuota 2 is pardoned, then un-pardoned
        THEN only cuota 2 carries the stamp, and un-pardoning clears it; the amount never moves
        """
        # GIVEN
        item = _installment_item()

        # WHEN
        pardoned = item.set_installment_pardon(2, pardoned_at=LATER)
        restored = pardoned.set_installment_pardon(2, pardoned_at=None)

        # THEN
        assert [cuota.pardoned for cuota in pardoned.installments] == [False, True, False]
        assert pardoned.installments[1].pardoned_at == LATER
        assert all(cuota.pardoned is False for cuota in restored.installments)
        assert pardoned.amount == item.amount == restored.amount

    def test_single_cuota_pardon_of_unknown_index_is_not_found(self):
        """
        GIVEN an installment item with 3 cuotas
        WHEN cuota 9 is pardoned
        THEN ReceivableInstallmentNotFoundError is raised
        """
        with pytest.raises(ReceivableInstallmentNotFoundError):
            _installment_item().set_installment_pardon(9, pardoned_at=LATER)

    def test_flat_item_pardon_toggles_the_item_stamp(self):
        """
        GIVEN a flat item
        WHEN it is pardoned, then un-pardoned
        THEN the item-level stamp is set, then cleared
        """
        item = _flat_item()
        pardoned = item.set_pardon(pardoned=True, at=LATER, paid_by_installment={})
        assert pardoned.pardoned_at == LATER
        assert pardoned.set_pardon(pardoned=False, at=LATER, paid_by_installment={}).pardoned is False

    def test_whole_plan_pardon_forgives_only_cuotas_still_owing(self):
        """
        GIVEN an installment item whose cuota 1 is fully paid, cuota 2 already pardoned
              earlier, and cuota 3 partially paid
        WHEN the whole remaining plan is pardoned
        THEN cuota 1 stays unpardoned (paid), cuota 2 keeps its original stamp, cuota 3 is
             stamped now; the item itself carries no item-level pardon (ADR-221)
        """
        # GIVEN
        item = _installment_item().set_installment_pardon(2, pardoned_at=A_TIME)
        first, _second, third = item.installments
        paid = {first.id: first.amount, third.id: Decimal("100")}

        # WHEN
        forgiven = item.set_pardon(pardoned=True, at=LATER, paid_by_installment=paid)

        # THEN
        assert [cuota.pardoned_at for cuota in forgiven.installments] == [None, A_TIME, LATER]
        assert forgiven.pardoned_at is None

    def test_whole_plan_unpardon_restores_every_cuota(self):
        """
        GIVEN an installment item with two pardoned cuotas
        WHEN the whole plan is un-pardoned
        THEN no cuota is pardoned any more
        """
        item = (
            _installment_item()
            .set_installment_pardon(1, pardoned_at=A_TIME)
            .set_installment_pardon(3, pardoned_at=A_TIME)
        )
        restored = item.set_pardon(pardoned=False, at=LATER, paid_by_installment={})
        assert all(cuota.pardoned is False for cuota in restored.installments)


class TestRevise:
    """Amount/plan revisions keep, reshape or lock the schedule (ADR-216)."""

    def test_unchanged_plan_and_amount_is_a_no_op_keeping_cuota_edits(self):
        """
        GIVEN an installment item whose cuota 3 was edited for interest
        WHEN the same plan and amount are re-sent
        THEN the very same item is returned — the per-cuota edit survives
        """
        # GIVEN
        item = _installment_item().edit_installment(3, amount=Decimal("400"), paid_by_installment={})

        # WHEN
        revised = item.revise(amount=item.amount, plan=item.plan, has_allocations=True, created_at=LATER)

        # THEN
        assert revised is item

    def test_flat_item_amount_edit_stays_flat(self):
        """
        GIVEN a flat item, even one with allocations
        WHEN only its amount changes
        THEN it stays flat with the new amount (the pre-installment behavior)
        """
        item = _flat_item()
        revised = item.revise(amount=Decimal("800"), plan=None, has_allocations=True, created_at=LATER)
        assert revised.amount == Decimal("800")
        assert revised.has_schedule is False

    def test_new_count_regenerates_the_schedule(self):
        """
        GIVEN a 3-cuota item with no allocations or pardons
        WHEN the plan becomes 4 cuotas from a new first due date
        THEN a fresh even schedule replaces the old one (new ids), same total
        """
        # GIVEN
        item = _installment_item()
        old_ids = {cuota.id for cuota in item.installments}

        # WHEN
        revised = item.revise(
            amount=None,
            plan=InstallmentPlan(count=4, first_due_on=date(2026, 10, 1)),
            has_allocations=False,
            created_at=LATER,
        )

        # THEN
        assert [cuota.amount for cuota in revised.installments] == [Decimal("250.00")] * 4
        assert revised.installments[0].due_on == date(2026, 10, 1)
        assert old_ids.isdisjoint(cuota.id for cuota in revised.installments)
        assert revised.amount == Decimal("1000.00")

    def test_new_total_on_an_installment_item_resplits_the_same_plan(self):
        """
        GIVEN a 3-cuota item
        WHEN only the amount changes to 1200
        THEN the same plan is re-split evenly over the new total
        """
        item = _installment_item()
        revised = item.revise(amount=Decimal("1200"), plan=item.plan, has_allocations=False, created_at=LATER)
        assert [cuota.amount for cuota in revised.installments] == [Decimal("400.00")] * 3
        assert revised.plan == item.plan

    def test_flat_item_converts_to_installments(self):
        """
        GIVEN a flat item with no allocations
        WHEN a 2-cuota plan is requested
        THEN the item gains the schedule over its current amount
        """
        item = _flat_item("1000")
        revised = item.revise(
            amount=None,
            plan=InstallmentPlan(count=2, first_due_on=FIRST_DUE),
            has_allocations=False,
            created_at=LATER,
        )
        assert [cuota.amount for cuota in revised.installments] == [Decimal("500.00"), Decimal("500.00")]
        assert all(cuota.created_at == LATER for cuota in revised.installments)

    def test_installment_item_converts_back_to_flat(self):
        """
        GIVEN a 3-cuota item with no allocations
        WHEN the plan is removed (and a new amount given)
        THEN the item becomes flat with that amount
        """
        item = _installment_item()
        revised = item.revise(amount=Decimal("900"), plan=None, has_allocations=False, created_at=LATER)
        assert revised.has_schedule is False
        assert revised.amount == Decimal("900")

    def test_allocations_lock_the_plan_shape(self):
        """
        GIVEN a 3-cuota item that already has allocations
        WHEN its count changes
        THEN InstallmentScheduleLockedError is raised with the allocations reason (ADR-216)
        """
        item = _installment_item()
        with pytest.raises(InstallmentScheduleLockedError) as excinfo:
            item.revise(
                amount=None,
                plan=InstallmentPlan(count=6, first_due_on=FIRST_DUE),
                has_allocations=True,
                created_at=LATER,
            )
        assert excinfo.value.reason == LOCKED_BY_ALLOCATIONS
        assert excinfo.value.item_id == item.id

    @pytest.mark.parametrize("pardon_on", ["cuota", "item"])
    def test_pardons_lock_the_plan_shape(self, pardon_on: str):
        """
        GIVEN an installment item with a pardoned cuota, or a pardoned flat item
        WHEN its plan would change shape
        THEN InstallmentScheduleLockedError is raised with the pardons reason
        """
        # GIVEN
        if pardon_on == "cuota":
            item = _installment_item().set_installment_pardon(1, pardoned_at=A_TIME)
            plan = InstallmentPlan(count=2, first_due_on=FIRST_DUE)
        else:
            item = _flat_item(pardoned_at=A_TIME)
            plan = InstallmentPlan(count=3, first_due_on=FIRST_DUE)

        # WHEN / THEN
        with pytest.raises(InstallmentScheduleLockedError) as excinfo:
            item.revise(amount=None, plan=plan, has_allocations=False, created_at=LATER)
        assert excinfo.value.reason == LOCKED_BY_PARDONS


class TestAllocationTarget:
    """Installment items are paid cuota by cuota, flat items as a whole (ADR-221, ADR-223)."""

    def test_installment_item_accepts_one_of_its_open_cuotas(self):
        """
        GIVEN an installment item
        WHEN an allocation names one of its cuotas
        THEN the target is accepted
        """
        item = _installment_item()
        item.check_allocation_target(item.installments[0].id)

    def test_installment_item_requires_a_cuota(self):
        """
        GIVEN an installment item
        WHEN an allocation names no cuota
        THEN InstallmentAllocationTargetError says a cuota is required
        """
        with pytest.raises(InstallmentAllocationTargetError) as excinfo:
            _installment_item().check_allocation_target(None)
        assert excinfo.value.requires_installment is True

    def test_installment_item_rejects_a_foreign_or_pardoned_cuota(self):
        """
        GIVEN an installment item with a pardoned cuota 2
        WHEN an allocation names an unknown cuota, or the pardoned one
        THEN ReceivableInstallmentNotFoundError is raised (a forgiven cuota is not payable)
        """
        item = _installment_item().set_installment_pardon(2, pardoned_at=A_TIME)
        with pytest.raises(ReceivableInstallmentNotFoundError):
            item.check_allocation_target(uuid4())
        with pytest.raises(ReceivableInstallmentNotFoundError):
            item.check_allocation_target(item.installments[1].id)

    def test_flat_item_rejects_a_cuota(self):
        """
        GIVEN a flat item
        WHEN an allocation names a cuota
        THEN InstallmentAllocationTargetError says the item has no cuotas
        """
        with pytest.raises(InstallmentAllocationTargetError) as excinfo:
            _flat_item().check_allocation_target(uuid4())
        assert excinfo.value.requires_installment is False

    def test_flat_item_accepts_the_item_unless_pardoned(self):
        """
        GIVEN a live flat item and a pardoned one
        WHEN each is targeted as a whole
        THEN the live one is accepted and the pardoned one is not found (ADR-210)
        """
        _flat_item().check_allocation_target(None)
        with pytest.raises(ReceivableItemNotFoundError):
            _flat_item(pardoned_at=A_TIME).check_allocation_target(None)


class TestAllocationCarriesTheCuota:
    """An allocation records the cuota it settles (ADR-221)."""

    def test_installment_id_is_carried(self):
        """
        GIVEN an allocation built for a cuota
        WHEN it is constructed
        THEN it carries the cuota id (and defaults to none for a flat item)
        """
        cuota_id = uuid4()
        allocation = build_receivable_allocation(
            payment_id=uuid4(), item_id=uuid4(), amount=Decimal("10"), installment_id=cuota_id
        )
        assert allocation.installment_id == cuota_id
        assert (
            build_receivable_allocation(payment_id=uuid4(), item_id=uuid4(), amount=Decimal("10")).installment_id
            is None
        )


class TestEditCommandContract:
    """The edit command's tri-state fields cannot both set and clear (ADR-216, ADR-217)."""

    def test_setting_and_removing_the_plan_is_rejected(self):
        """
        GIVEN a patch that both sets and removes the installment plan
        WHEN the command is built
        THEN Pydantic rejects it
        """
        with pytest.raises(ValueError, match="cannot both set and remove"):
            EditReceivableItem(
                id=uuid4(),
                user_id="u",
                person_id=uuid4(),
                installments=InstallmentPlanInput(count=2, first_due_on=FIRST_DUE),
                remove_installments=True,
            )

    def test_linking_and_unlinking_is_rejected(self):
        """
        GIVEN a patch that both links and unlinks the source expense
        WHEN the command is built
        THEN Pydantic rejects it
        """
        with pytest.raises(ValueError, match="cannot both link and unlink"):
            EditReceivableItem(
                id=uuid4(),
                user_id="u",
                person_id=uuid4(),
                source_transaction_id=uuid4(),
                unlink_source_transaction=True,
            )

    def test_consistent_patch_is_accepted(self):
        """
        GIVEN a patch that removes the plan and unlinks the expense
        WHEN the command is built
        THEN it is valid
        """
        command = EditReceivableItem(
            id=uuid4(), user_id="u", person_id=uuid4(), remove_installments=True, unlink_source_transaction=True
        )
        assert command.remove_installments is True
        assert command.unlink_source_transaction is True


class TestCuotaEditFloor:
    """A cuota can never be lowered below what was already paid toward it (ADR-216)."""

    def test_lowering_a_cuota_below_its_payments_is_rejected(self):
        """
        GIVEN cuota 1 (333.33) with 80 already paid toward it
        WHEN its amount is edited to 50
        THEN InstallmentAmountBelowPaidError names the cuota, what was paid and the refused amount
        """
        # GIVEN
        item = _installment_item()
        first = item.installments[0]

        # WHEN / THEN
        with pytest.raises(InstallmentAmountBelowPaidError) as excinfo:
            item.edit_installment(1, amount=Decimal("50"), paid_by_installment={first.id: Decimal("80")})
        assert (excinfo.value.item_id, excinfo.value.index) == (item.id, 1)
        assert (excinfo.value.paid, excinfo.value.amount) == (Decimal("80"), Decimal("50.00"))

    def test_a_cuota_may_be_lowered_down_to_its_payments(self):
        """
        GIVEN cuota 1 with 80 already paid toward it
        WHEN its amount is edited to exactly 80
        THEN the edit is accepted
        """
        item = _installment_item()
        edited = item.edit_installment(
            1, amount=Decimal("80"), paid_by_installment={item.installments[0].id: Decimal("80")}
        )
        assert edited.installments[0].amount == Decimal("80.00")

    def test_moving_an_overpaid_cuota_keeps_working(self):
        """
        GIVEN cuota 1 already paid beyond its amount
        WHEN only its due date is edited
        THEN the edit is accepted (the floor only guards amount changes)
        """
        item = _installment_item()
        edited = item.edit_installment(
            1, due_on=date(2026, 9, 1), paid_by_installment={item.installments[0].id: Decimal("500")}
        )
        assert edited.installments[0].due_on == date(2026, 9, 1)


class TestCreationAdjustments:
    """Per-cuota tweaks are applied in the same build that creates the item (ADR-216)."""

    def test_adjustments_apply_and_rederive_the_amount(self):
        """
        GIVEN a 1000 plan of 3 cuotas with cuota 3 raised to 400 and cuota 1 moved earlier
        WHEN the item is built
        THEN the schedule reads 333.33 / 333.33 / 400.00, cuota 1 falls due on the new date and
             the item amount is the resulting sum 1066.66
        """
        # WHEN
        item = build_receivable_item(
            person_id=uuid4(),
            occurred_on=A_DATE,
            amount=Decimal("1000"),
            plan=InstallmentPlan(count=3, first_due_on=FIRST_DUE),
            adjustments=(
                InstallmentAdjustment(index=3, amount=Decimal("400")),
                InstallmentAdjustment(index=1, due_on=date(2026, 9, 1)),
            ),
        )

        # THEN
        assert [cuota.amount for cuota in item.installments] == [
            Decimal("333.33"),
            Decimal("333.33"),
            Decimal("400.00"),
        ]
        assert item.installments[0].due_on == date(2026, 9, 1)
        assert item.amount == Decimal("1066.66")

    @pytest.mark.parametrize(
        ("plan", "adjustments", "message"),
        [
            (InstallmentPlan(3, FIRST_DUE), (InstallmentAdjustment(index=4, amount=Decimal("1")),), "no cuota 4"),
            (
                InstallmentPlan(3, FIRST_DUE),
                (InstallmentAdjustment(index=2, amount=Decimal("1")), InstallmentAdjustment(index=2)),
                "at most once",
            ),
            (None, (InstallmentAdjustment(index=1, amount=Decimal("1")),), "no cuota 1 in a plan of 0"),
        ],
        ids=["index-out-of-plan", "index-twice", "no-plan"],
    )
    def test_invalid_adjustments_are_rejected(
        self,
        plan: InstallmentPlan | None,
        adjustments: tuple[InstallmentAdjustment, ...],
        message: str,
    ):
        """
        GIVEN adjustments naming a cuota the plan does not have, one cuota twice, or no plan
        WHEN the item is built
        THEN InvalidInstallmentScheduleError explains the problem
        """
        with pytest.raises(InvalidInstallmentScheduleError, match=message):
            build_receivable_item(
                person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("1000"), plan=plan, adjustments=adjustments
            )

    def test_command_input_translates_to_domain_adjustments(self):
        """
        GIVEN the creation command's nested plan with a cuota tweak
        WHEN it is translated
        THEN the domain plan and adjustments carry the same values
        """
        plan_input = NewInstallmentPlanInput(
            count=2,
            first_due_on=FIRST_DUE,
            cuotas=(InstallmentAdjustmentInput(index=2, amount=Decimal("600"), due_on=date(2026, 11, 1)),),
        )
        assert plan_input.to_plan() == InstallmentPlan(2, FIRST_DUE)
        assert plan_input.to_adjustments() == (InstallmentAdjustment(2, Decimal("600"), date(2026, 11, 1)),)


class TestSameTerms:
    """Recognizing a retried creation compares terms, not identities (ADR-204)."""

    def test_rebuilt_item_has_the_same_terms_whatever_its_cuota_ids_or_pardons(self):
        """
        GIVEN an installment item and the same request rebuilt (fresh cuota ids), later pardoned
        WHEN their terms are compared
        THEN they match
        """
        # GIVEN
        item_id, person_id = uuid4(), uuid4()

        def build(amount: str = "1000", detail: str | None = "TV", count: int = 3) -> ReceivableItem:
            return build_receivable_item(
                item_id=item_id,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal(amount),
                detail=detail,
                plan=InstallmentPlan(count=count, first_due_on=FIRST_DUE),
            )

        original = build()

        # THEN
        assert original.has_same_terms(build())
        assert original.has_same_terms(build().set_installment_pardon(1, pardoned_at=A_TIME))
        assert not original.has_same_terms(build(amount="900"))
        assert not original.has_same_terms(build(detail="Cena"))
        assert not original.has_same_terms(build(count=4))
