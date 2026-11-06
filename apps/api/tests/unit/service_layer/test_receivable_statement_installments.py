"""Unit tests for the per-cuota receivable statement (ADR-222, amending ADR-211/212).

The read models here are assessed by the REAL settlement policy
(:func:`~margen_api.domain.models.receivable_settlement.assess_item`) as of a fixed "today", so
every cuota status, the due-only hero (``person.outstanding``) and the upcoming total are the
figures the reader would produce, not hand-typed numbers. That lets each scenario assert the
invariant ADR-222 exists for: the ledger's running Saldo closes on the due-only hero in both
content modes and both languages.

The main scenario (as of Nov 6 2026): Maria owes a flat 5.000 dinner ("Cena", Oct 20) next to a
6 x 10.000 "TV" plan due on the 10th from Aug 10. Cuota 1/6 is paid, 2/6 forgiven, 3/6 due with
4.000 paid (6.000 left) and 4/6 to 6/6 are upcoming. Hero = 5.000 + 6.000 = 11.000; upcoming =
30.000; total consumed = 5.000 + 50.000 (the forgiven cuota excluded) = 55.000.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.receivable import ReceivableInstallment, ReceivableItem
from margen_api.domain.models.receivable_settlement import (
    NO_ALLOCATIONS,
    InstallmentStatus,
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
from margen_api.service_layer.receivable_statement import (
    Locale,
    StatementView,
    build_statement_view,
    render_statement_html,
)

_TODAY = date(2026, 11, 6)
_PERSON_ID = UUID("11111111-1111-4111-8111-111111111111")
_CREATED = datetime(2026, 1, 1, tzinfo=UTC)
_PARDONED_AT = datetime(2026, 10, 1, tzinfo=UTC)
_OWNER = "Tomas Sanchez"
_TEN_THOUSAND = "10000.00"

# The em-dash and en-dash that must NEVER appear in the rendered document (ADR-209/211).
_EM_DASH = "—"
_EN_DASH = "–"
# The real Unicode minus on a full-history payment amount.
_MINUS = "−"


@dataclass(frozen=True, slots=True)
class _CuotaSpec:
    """One cuota of a test plan: when it falls due, what was paid toward it, and whether it is forgiven."""

    due_on: date
    paid: str = "0"
    pardoned: bool = False


def _installment_item(
    detail: str | None,
    specs: Sequence[_CuotaSpec],
    *,
    occurred_on: date,
    cuota_amount: str = _TEN_THOUSAND,
) -> ItemPosition:
    """Build an installment item from cuota specs and assess it as of ``_TODAY``."""
    item_id = uuid4()
    cuotas = tuple(
        ReceivableInstallment(
            id=uuid4(),
            item_id=item_id,
            index=index,
            due_on=spec.due_on,
            amount=Decimal(cuota_amount),
            pardoned_at=_PARDONED_AT if spec.pardoned else None,
            created_at=_CREATED,
        )
        for index, spec in enumerate(specs, start=1)
    )
    item = ReceivableItem(
        id=item_id,
        person_id=_PERSON_ID,
        occurred_on=occurred_on,
        amount=sum((cuota.amount for cuota in cuotas), Decimal(0)),
        detail=detail,
        created_at=_CREATED,
        installments=cuotas,
    )
    paid = {cuota.id: Decimal(spec.paid) for cuota, spec in zip(cuotas, specs, strict=True) if Decimal(spec.paid)}
    allocations = ItemAllocations(total=sum(paid.values(), Decimal(0)), by_installment=paid)
    return assess_item(item, allocations, _TODAY)


def _flat_item(detail: str, amount: str, *, occurred_on: date) -> ItemPosition:
    """Build an unpaid flat item and assess it as of ``_TODAY``."""
    item = ReceivableItem(
        id=uuid4(),
        person_id=_PERSON_ID,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        detail=detail,
        created_at=_CREATED,
    )
    return assess_item(item, NO_ALLOCATIONS, _TODAY)


def _read_model(position: ItemPosition) -> ReceivableItemReadModel:
    """Project an assessed position into the read model, as the reader does (ADR-215)."""
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


def _person(positions: Sequence[ItemPosition], payments: Sequence[tuple[date, str]] = ()) -> PersonDetailReadModel:
    """Wrap assessed items and paybacks into a person detail, newest-first like the reader."""
    items = sorted(positions, key=lambda position: position.item.occurred_on, reverse=True)
    return PersonDetailReadModel(
        id=_PERSON_ID,
        name="Maria Gabriela",
        created_at=_CREATED,
        outstanding=person_outstanding(items),
        items=tuple(_read_model(position) for position in items),
        payments=tuple(
            ReceivablePaymentReadModel(occurred_on=occurred_on, amount=Decimal(amount))
            for occurred_on, amount in sorted(payments, reverse=True)
        ),
        upcoming_total=person_upcoming(items),
    )


def _tv_plan(*, second_paid: str = "0", fourth_paid: str = "0") -> ItemPosition:
    """The 6 x 10.000 "TV" plan as of Nov 6 2026: paid, forgiven, part-paid due, then 3 upcoming."""
    return _installment_item(
        "TV",
        (
            _CuotaSpec(date(2026, 8, 10), paid=_TEN_THOUSAND),  # 1/6 paid.
            _CuotaSpec(date(2026, 9, 10), paid=second_paid, pardoned=True),  # 2/6 forgiven.
            _CuotaSpec(date(2026, 10, 10), paid="4000"),  # 3/6 due, 6.000 left.
            _CuotaSpec(date(2026, 11, 10), paid=fourth_paid),  # 4/6 upcoming.
            _CuotaSpec(date(2026, 12, 10)),  # 5/6 upcoming.
            _CuotaSpec(date(2027, 1, 10)),  # 6/6 upcoming.
        ),
        occurred_on=date(2026, 8, 1),
    )


_DINNER_DATE = date(2026, 10, 20)
_BASE_PAYMENTS = ((date(2026, 8, 12), _TEN_THOUSAND), (date(2026, 10, 15), "4000"))


def _tv_person() -> PersonDetailReadModel:
    """Maria: the flat 5.000 dinner next to the TV plan; she paid cuota 1 and 4.000 of cuota 3."""
    return _person([_flat_item("Cena", "5000", occurred_on=_DINNER_DATE), _tv_plan()], _BASE_PAYMENTS)


def _paid_ahead_person() -> PersonDetailReadModel:
    """As :func:`_tv_person`, plus 3.000 paid ahead toward the still-upcoming cuota 4/6."""
    return _person(
        [_flat_item("Cena", "5000", occurred_on=_DINNER_DATE), _tv_plan(fourth_paid="3000")],
        (*_BASE_PAYMENTS, (date(2026, 10, 30), "3000")),
    )


def _paid_then_forgiven_person() -> PersonDetailReadModel:
    """As :func:`_tv_person`, but 2.500 of cuota 2/6 was paid before the rest was forgiven."""
    return _person(
        [_flat_item("Cena", "5000", occurred_on=_DINNER_DATE), _tv_plan(second_paid="2500")],
        (*_BASE_PAYMENTS, (date(2026, 9, 12), "2500")),
    )


def _fully_paid_then_forgiven_person() -> PersonDetailReadModel:
    """As :func:`_tv_person`, but cuota 2/6 was paid in full before being marked forgiven."""
    return _person(
        [_flat_item("Cena", "5000", occurred_on=_DINNER_DATE), _tv_plan(second_paid=_TEN_THOUSAND)],
        (*_BASE_PAYMENTS, (date(2026, 9, 12), _TEN_THOUSAND)),
    )


def _view(person: PersonDetailReadModel, *, lang: Locale = "es", full_history: bool = False) -> StatementView:
    """Build the statement view for ``person`` as of ``_TODAY``."""
    return build_statement_view(person, owner_name=_OWNER, lang=lang, full_history=full_history, today=_TODAY)


def _rows(view: StatementView) -> list[tuple[str, str, str, str, InstallmentStatus | None, str]]:
    """Flatten the ledger into ``(date, detail, amount, balance, status, tag)`` tuples."""
    return [
        (row.occurred_on, row.detail, row.amount, row.balance, row.status, row.status_label) for row in view.ledger_rows
    ]


_Scenario = Callable[[], PersonDetailReadModel]

_SCENARIOS: dict[str, _Scenario] = {
    "paid-forgiven-due-upcoming": _tv_person,
    "paid-ahead-on-an-upcoming-cuota": _paid_ahead_person,
    "part-paid-then-forgiven": _paid_then_forgiven_person,
    "fully-paid-then-forgiven": _fully_paid_then_forgiven_person,
}


class TestOutstandingOnlyLedger:
    """The default ledger lists one row per DUE cuota and keeps upcoming cuotas apart (ADR-222)."""

    def test_spanish_rows_are_the_due_cuota_and_the_owed_flat_item(self) -> None:
        """
        GIVEN the TV plan (paid, forgiven, due, 3 upcoming) and a flat dinner, as of Nov 6 2026
        WHEN the default Spanish statement is built
        THEN the only rows are cuota 3/6 at its remaining 6.000 (dated by its due date) and the
             dinner, date-ascending, closing on the hero 11.000 with no status tags
        """
        view = _view(_tv_person())

        assert _rows(view) == [
            ("10/10/2026", "TV · Cuota 3/6", "6.000,00", "6.000,00", None, ""),
            ("20/10/2026", "Cena", "5.000,00", "11.000,00", None, ""),
        ]
        assert (view.hero_amount_main, view.hero_amount_frac) == ("11.000", ",00")
        assert view.balance_to_date_value == "11.000,00"

    def test_english_rows(self) -> None:
        """GIVEN the TV person WHEN built in English THEN cuotas read "Installment N/M" in en-US format."""
        view = _view(_tv_person(), lang="en")

        assert _rows(view) == [
            ("10/10/2026", "TV · Installment 3/6", "6,000.00", "6,000.00", None, ""),
            ("10/20/2026", "Cena", "5,000.00", "11,000.00", None, ""),
        ]
        assert view.balance_to_date_value == "11,000.00"

    def test_upcoming_strip_is_informational_and_apart_from_the_hero(self) -> None:
        """
        GIVEN 30.000 of upcoming cuotas
        WHEN the default statement is built
        THEN the upcoming strip shows 30.000 while the hero and pending stat stay at the due 11.000
        """
        view = _view(_tv_person())

        assert view.show_upcoming is True
        assert (view.upcoming_label, view.upcoming_value) == ("Próximas cuotas", "30.000,00")
        assert view.upcoming_note == "Todavía no vencen, así que no entran en el saldo pendiente."
        assert view.stat_pending_value == "11.000,00"

    def test_upcoming_strip_english(self) -> None:
        view = _view(_tv_person(), lang="en")

        assert (view.upcoming_label, view.upcoming_value) == ("Upcoming installments", "30,000.00")
        assert view.upcoming_note == "Not due yet, so they are not part of the balance due."

    def test_paid_ahead_part_shrinks_the_upcoming_strip_not_the_hero(self) -> None:
        """GIVEN 3.000 paid ahead on cuota 4/6 THEN upcoming is 27.000 and the rows are unchanged."""
        view = _view(_paid_ahead_person())

        assert view.upcoming_value == "27.000,00"
        assert [(row.detail, row.amount) for row in view.ledger_rows] == [
            ("TV · Cuota 3/6", "6.000,00"),
            ("Cena", "5.000,00"),
        ]

    def test_only_upcoming_cuotas_show_the_empty_state_and_the_strip(self) -> None:
        """
        GIVEN a plan whose first cuota is not due yet and nothing else owed
        WHEN the default statement is built
        THEN nothing is owed now (empty ledger, zero hero) but the upcoming strip carries the plan
        """
        plan = _installment_item(
            "Bici",
            (_CuotaSpec(date(2026, 12, 1)), _CuotaSpec(date(2027, 1, 1))),
            occurred_on=date(2026, 11, 1),
            cuota_amount="2500.00",
        )

        view = _view(_person([plan]))

        assert view.ledger_rows == ()
        assert view.balance_to_date_value == "0,00"
        assert (view.show_upcoming, view.upcoming_value) == (True, "5.000,00")

    def test_strip_hidden_when_nothing_is_upcoming(self) -> None:
        """GIVEN every cuota already due WHEN built THEN no upcoming strip is shown."""
        plan = _installment_item(
            "Bici",
            (_CuotaSpec(date(2026, 9, 1)), _CuotaSpec(date(2026, 10, 1))),
            occurred_on=date(2026, 8, 20),
        )

        view = _view(_person([plan]))

        assert view.show_upcoming is False
        assert [row.detail for row in view.ledger_rows] == ["Bici · Cuota 1/2", "Bici · Cuota 2/2"]

    @pytest.mark.parametrize(("lang", "label"), [("es", "Cuota 1/2"), ("en", "Installment 1/2")])
    def test_item_without_detail_shows_the_position_alone(self, lang: Locale, label: str) -> None:
        """GIVEN an installment item with no detail THEN its cuota rows read just "Cuota N/M"."""
        plan = _installment_item(
            None,
            (_CuotaSpec(date(2026, 10, 1)), _CuotaSpec(date(2026, 12, 1))),
            occurred_on=date(2026, 9, 20),
        )

        view = _view(_person([plan]), lang=lang)

        assert [row.detail for row in view.ledger_rows] == [label]


class TestFullHistoryLedger:
    """With full_history=True every cuota is listed with its status (ADR-222)."""

    def test_spanish_rows_list_every_cuota_with_its_status(self) -> None:
        """
        GIVEN the TV person
        WHEN the full-history Spanish statement is built
        THEN due and paid cuotas are charges at their full amount netted by the payments, the
             forgiven and upcoming cuotas are listed with an empty Saldo, and it closes on 11.000
        """
        view = _view(_tv_person(), full_history=True)

        assert _rows(view) == [
            ("10/08/2026", "TV · Cuota 1/6", "10.000,00", "10.000,00", InstallmentStatus.PAID, "Pagada"),
            ("12/08/2026", "Pago recibido", f"{_MINUS} 10.000,00", "0,00", None, ""),
            ("10/09/2026", "TV · Cuota 2/6", "10.000,00", "", InstallmentStatus.PARDONED, "Perdonada"),
            ("10/10/2026", "TV · Cuota 3/6", "10.000,00", "10.000,00", InstallmentStatus.DUE, "Pendiente"),
            ("15/10/2026", "Pago recibido", f"{_MINUS} 4.000,00", "6.000,00", None, ""),
            ("20/10/2026", "Cena", "5.000,00", "11.000,00", None, ""),
            ("10/11/2026", "TV · Cuota 4/6", "10.000,00", "", InstallmentStatus.UPCOMING, "Próxima"),
            ("10/12/2026", "TV · Cuota 5/6", "10.000,00", "", InstallmentStatus.UPCOMING, "Próxima"),
            ("10/01/2027", "TV · Cuota 6/6", "10.000,00", "", InstallmentStatus.UPCOMING, "Próxima"),
        ]
        assert view.balance_to_date_value == "11.000,00"

    def test_english_tags(self) -> None:
        """GIVEN the TV person WHEN built in English THEN cuota rows carry the en status tags."""
        view = _view(_tv_person(), lang="en", full_history=True)

        cuota_rows = [(row.detail, row.status_label) for row in view.ledger_rows if row.status is not None]
        assert cuota_rows == [
            ("TV · Installment 1/6", "Paid"),
            ("TV · Installment 2/6", "Forgiven"),
            ("TV · Installment 3/6", "Due"),
            ("TV · Installment 4/6", "Upcoming"),
            ("TV · Installment 5/6", "Upcoming"),
            ("TV · Installment 6/6", "Upcoming"),
        ]
        assert view.ledger_rows[0].amount == "10,000.00"
        assert view.balance_to_date_value == "11,000.00"

    def test_upcoming_and_forgiven_rows_stay_out_of_the_balance(self) -> None:
        view = _view(_tv_person(), full_history=True)

        outside = [row for row in view.ledger_rows if not row.in_balance]
        assert {row.status for row in outside} == {InstallmentStatus.UPCOMING, InstallmentStatus.PARDONED}
        assert all(row.balance == "" for row in outside)

    def test_part_paid_ahead_cuota_splits_into_its_paid_and_upcoming_parts(self) -> None:
        """
        GIVEN 3.000 paid ahead toward the upcoming cuota 4/6
        WHEN the full history is built
        THEN cuota 4/6 shows a paid 3.000 charge (netting that payment) and an upcoming 7.000 row
        """
        view = _view(_paid_ahead_person(), full_history=True)

        assert _rows(view)[6:9] == [
            ("30/10/2026", "Pago recibido", f"{_MINUS} 3.000,00", "8.000,00", None, ""),
            ("10/11/2026", "TV · Cuota 4/6", "3.000,00", "11.000,00", InstallmentStatus.PAID, "Pagada"),
            ("10/11/2026", "TV · Cuota 4/6", "7.000,00", "", InstallmentStatus.UPCOMING, "Próxima"),
        ]

    def test_part_paid_then_forgiven_cuota_splits_into_its_paid_and_forgiven_parts(self) -> None:
        """GIVEN 2.500 of cuota 2/6 paid before the pardon THEN it splits 2.500 paid / 7.500 forgiven."""
        view = _view(_paid_then_forgiven_person(), full_history=True)

        assert _rows(view)[2:5] == [
            ("10/09/2026", "TV · Cuota 2/6", "2.500,00", "2.500,00", InstallmentStatus.PAID, "Pagada"),
            ("10/09/2026", "TV · Cuota 2/6", "7.500,00", "", InstallmentStatus.PARDONED, "Perdonada"),
            ("12/09/2026", "Pago recibido", f"{_MINUS} 2.500,00", "0,00", None, ""),
        ]

    def test_fully_paid_then_forgiven_cuota_is_a_plain_paid_charge(self) -> None:
        """GIVEN cuota 2/6 paid in full and then marked forgiven THEN nothing was forgiven: one paid row."""
        view = _view(_fully_paid_then_forgiven_person(), full_history=True)

        second = [row for row in view.ledger_rows if row.detail == "TV · Cuota 2/6"]
        assert [(row.amount, row.balance, row.status) for row in second] == [
            ("10.000,00", "10.000,00", InstallmentStatus.PAID),
        ]


class TestRunningTotalMatchesHero:
    """The Saldo column closes on the due-only hero in both modes and languages (ADR-215, ADR-222)."""

    @pytest.mark.parametrize("scenario", _SCENARIOS.values(), ids=_SCENARIOS.keys())
    @pytest.mark.parametrize("full_history", [False, True])
    @pytest.mark.parametrize("lang", ["es", "en"])
    def test_last_running_balance_equals_the_hero(self, scenario: _Scenario, full_history: bool, lang: Locale) -> None:
        """
        GIVEN a person whose plan has due, upcoming, paid and forgiven cuotas
        WHEN the statement is built in either mode and language
        THEN the last Saldo carried down the ledger equals the hero and "Saldo a la fecha"
        """
        person = scenario()

        view = _view(person, lang=lang, full_history=full_history)

        last_balance = [row.balance for row in view.ledger_rows if row.in_balance][-1]
        hero = view.hero_amount_main + view.hero_amount_frac
        assert person.outstanding == Decimal("11000.00")
        assert last_balance == hero == view.balance_to_date_value == view.stat_pending_value


class TestStatsAndCoveredBox:
    """Stats and the covered box work at the cuota grain for installment items (ADR-210, ADR-221)."""

    def test_total_consumed_excludes_forgiven_cuotas(self) -> None:
        """GIVEN the forgiven cuota 2/6 THEN total consumed is 5.000 + 50.000, paid is 14.000."""
        view = _view(_tv_person())

        assert view.stat_total_value == "55.000,00"
        assert view.stat_paid_value == "14.000,00"

    @pytest.mark.parametrize("full_history", [False, True])
    def test_forgiven_cuota_is_covered_in_both_modes(self, full_history: bool) -> None:
        view = _view(_tv_person(), full_history=full_history)

        assert view.show_covered is True
        assert [(row.occurred_on, row.detail, row.amount) for row in view.covered_rows] == [
            ("10/09/2026", "TV · Cuota 2/6", "10.000,00"),
        ]

    def test_covered_amount_is_what_was_left_at_the_pardon(self) -> None:
        view = _view(_paid_then_forgiven_person(), lang="en")

        assert [(row.occurred_on, row.detail, row.amount) for row in view.covered_rows] == [
            ("09/10/2026", "TV · Installment 2/6", "7,500.00"),
        ]

    def test_fully_paid_forgiven_cuota_is_not_covered(self) -> None:
        view = _view(_fully_paid_then_forgiven_person())

        assert view.show_covered is False

    def test_wholly_forgiven_plan_is_covered_per_cuota_not_as_one_item(self) -> None:
        """
        GIVEN a 2-cuota plan whose first cuota is paid and second forgiven (the plan reads as pardoned)
        WHEN the default statement is built
        THEN only the forgiven cuota is covered and nothing is owed
        """
        plan = _installment_item(
            "Bici",
            (_CuotaSpec(date(2026, 9, 1), paid="5000"), _CuotaSpec(date(2026, 10, 1), pardoned=True)),
            occurred_on=date(2026, 8, 20),
            cuota_amount="5000.00",
        )
        person = _person([plan], [(date(2026, 9, 2), "5000")])

        view = _view(person)

        assert person.items[0].pardoned is True
        assert [(row.detail, row.amount) for row in view.covered_rows] == [("Bici · Cuota 2/2", "5.000,00")]
        assert view.ledger_rows == ()
        assert view.stat_total_value == "5.000,00"


class TestRenderHtml:
    """The template renders the cuota rows, tags and the upcoming strip (ADR-222)."""

    def test_outstanding_only_html_lists_due_cuotas_and_the_strip(self) -> None:
        html = render_statement_html(_view(_tv_person()))

        assert "TV · Cuota 3/6" in html
        assert "TV · Cuota 4/6" not in html  # upcoming cuotas are not ledger rows by default.
        assert '<div class="upcoming">' in html
        for fragment in ("Próximas cuotas", "30.000,00", "no entran en el saldo pendiente"):
            assert fragment in html, fragment
        assert '<span class="tag ' not in html  # no status tags in the outstanding-only ledger.
        assert '<td class="c-bal total">11.000,00</td>' in html

    def test_full_history_html_tags_every_cuota_and_mutes_the_out_of_balance_ones(self) -> None:
        html = render_statement_html(_view(_tv_person(), lang="en", full_history=True))

        for fragment in (
            '<span class="tag tag-paid">Paid</span>',
            '<span class="tag tag-pardoned">Forgiven</span>',
            '<span class="tag tag-due">Due</span>',
            '<span class="tag tag-upcoming">Upcoming</span>',
            '<tr class="charge info">',
            '<tr class="charge info last">',
            "Upcoming installments",
            '<td class="c-bal total">11,000.00</td>',
        ):
            assert fragment in html, fragment

    def test_strip_absent_without_upcoming_cuotas(self) -> None:
        plan = _installment_item(
            "Bici",
            (_CuotaSpec(date(2026, 9, 1)), _CuotaSpec(date(2026, 10, 1))),
            occurred_on=date(2026, 8, 20),
        )

        html = render_statement_html(_view(_person([plan])))

        assert '<div class="upcoming">' not in html
        assert "Próximas cuotas" not in html

    @pytest.mark.parametrize("scenario", _SCENARIOS.values(), ids=_SCENARIOS.keys())
    @pytest.mark.parametrize("full_history", [False, True])
    @pytest.mark.parametrize("lang", ["es", "en"])
    def test_no_em_or_en_dash(self, scenario: _Scenario, full_history: bool, lang: Locale) -> None:
        """GIVEN any installment scenario, mode and locale THEN no em/en dash reaches the HTML."""
        html = render_statement_html(_view(scenario(), lang=lang, full_history=full_history))

        assert _EM_DASH not in html
        assert _EN_DASH not in html
