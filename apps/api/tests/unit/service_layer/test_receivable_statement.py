"""Unit tests for the pure receivable-statement builders and template (ADR-211/212).

These exercise the two I/O-free layers with NO WeasyPrint: the view-model assembly
(:func:`build_statement_view`) and the template-to-HTML rendering (:func:`render_statement_html`).
They assert the two-language copy and es-AR/en-US number and date formatting, the authoritative
outstanding hero, the three all-time stats, BOTH ledger content modes (ADR-212 — the default
outstanding-only ledger listing only still-owed items at their remaining with no payment rows and
its calm "al día" empty state, and the opt-in full running-balance ledger over interleaved
charges and payments), the covered box present/absent, the owner signed into the footer, the
page-counter words, and the guard that no em/en dash ever reaches the rendered HTML (only the real
Unicode minus on a full-mode payment amount). The single native WeasyPrint call is stubbed where
the composed entry point is exercised.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

import pytest

from margen_api.service_layer import receivable_statement
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableItemReadModel,
    ReceivablePaymentReadModel,
)
from margen_api.service_layer.receivable_statement import (
    Locale,
    build_statement_pdf,
    build_statement_view,
    normalize_locale,
    pdf_filename,
    render_statement_html,
)

_PERSON_ID = UUID("11111111-1111-4111-8111-111111111111")
_ITEM_ID = UUID("22222222-2222-4222-8222-222222222222")
_CREATED = datetime(2026, 1, 1)
_TODAY = date(2026, 8, 29)
_OWNER = "Tomas Sanchez"

# The em-dash and en-dash that must NEVER appear in the rendered document (ADR-209/211).
_EM_DASH = "—"
_EN_DASH = "–"
# The ONLY dash-like glyph allowed: the real Unicode minus on a payment amount.
_MINUS = "−"


def _item(
    *,
    occurred_on: date = date(2026, 8, 26),
    amount: str = "1000.00",
    detail: str | None = "lunch",
    allocated: str = "0.00",
    remaining: str = "1000.00",
    pardoned: bool = False,
) -> ReceivableItemReadModel:
    """Build a receivable item read model with sensible defaults."""
    return ReceivableItemReadModel(
        id=_ITEM_ID,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        detail=detail,
        allocated=Decimal(allocated),
        remaining=Decimal(remaining),
        pardoned=pardoned,
    )


def _payment(*, occurred_on: date = date(2026, 8, 29), amount: str = "300.00") -> ReceivablePaymentReadModel:
    """Build a payback read model with a sensible default amount."""
    return ReceivablePaymentReadModel(occurred_on=occurred_on, amount=Decimal(amount))


def _person(
    *,
    name: str = "Maria Gabriela",
    outstanding: str = "1000.00",
    items: tuple[ReceivableItemReadModel, ...] = (),
    payments: tuple[ReceivablePaymentReadModel, ...] = (),
) -> PersonDetailReadModel:
    """Build a person-detail read model wrapping the given items and payments."""
    return PersonDetailReadModel(
        id=_PERSON_ID,
        name=name,
        created_at=_CREATED,
        outstanding=Decimal(outstanding),
        items=items,
        payments=payments,
    )


def _rich_person() -> PersonDetailReadModel:
    """A person with 3 charges across dates, 2 payments and 1 pardoned item.

    total consumed = 24500 + 10000 + 10000 = 44500; paid = 10000 + 5000 = 15000;
    outstanding (authoritative) = 29500. The pardoned 7000 sits only in the covered box.
    """
    return _person(
        name="Maria Gabriela",
        outstanding="29500.00",
        items=(
            _item(occurred_on=date(2026, 8, 26), amount="24500.00", detail="TGI Fridays", remaining="24500.00"),
            _item(occurred_on=date(2026, 8, 28), amount="10000.00", detail="La Yerra", remaining="10000.00"),
            _item(occurred_on=date(2026, 8, 28), amount="10000.00", detail="La Yerra", remaining="10000.00"),
            _item(occurred_on=date(2026, 8, 26), amount="7000.00", detail="Gloria", remaining="7000.00", pardoned=True),
        ),
        payments=(
            _payment(occurred_on=date(2026, 8, 29), amount="10000.00"),
            _payment(occurred_on=date(2026, 8, 30), amount="5000.00"),
        ),
    )


def _settled_person() -> PersonDetailReadModel:
    """A person whose per-item remainders reflect real allocations, so the two modes diverge.

    One fully-paid item (remaining 0, dropped from the outstanding-only ledger), one
    partially-paid item (remaining 4000), one untouched item (remaining 10000) and one pardoned
    item (the covered box). total consumed = 44500; paid = 30500; outstanding = 14000 = 4000 +
    10000 — the fully-paid and the pardoned item contribute nothing to what is still owed. In
    outstanding-only mode the ledger shows just the two owed items at their remaining; in full
    mode it shows every charge at its gross amount interleaved with the two payments.
    """
    return _person(
        name="Maria Gabriela",
        outstanding="14000.00",
        items=(
            _item(
                occurred_on=date(2026, 8, 26),
                amount="24500.00",
                detail="TGI Fridays",
                allocated="24500.00",
                remaining="0.00",
            ),
            _item(
                occurred_on=date(2026, 8, 28),
                amount="10000.00",
                detail="La Yerra",
                allocated="6000.00",
                remaining="4000.00",
            ),
            _item(
                occurred_on=date(2026, 8, 30),
                amount="10000.00",
                detail="Aeropuerto taxi",
                allocated="0.00",
                remaining="10000.00",
            ),
            _item(occurred_on=date(2026, 8, 26), amount="7000.00", detail="Gloria", remaining="7000.00", pardoned=True),
        ),
        payments=(
            _payment(occurred_on=date(2026, 8, 27), amount="24500.00"),
            _payment(occurred_on=date(2026, 8, 29), amount="6000.00"),
        ),
    )


class TestNormalizeLocale:
    """The ``lang`` query value normalizes to a supported locale (ADR-209/211)."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("en", "en"),
            ("en-US", "en"),
            ("EN", "en"),
            (" en ", "en"),
            ("es", "es"),
            ("es-AR", "es"),
            ("fr", "es"),
            ("", "es"),
            (None, "es"),
        ],
    )
    def test_normalizes(self, raw: str | None, expected: Locale) -> None:
        """GIVEN a raw lang value WHEN normalized THEN English tags map to en, all else to es."""
        assert normalize_locale(raw) == expected


class TestPdfFilename:
    """The download filename is a safe slug of the person's name (ADR-209/211)."""

    def test_slugifies_name(self) -> None:
        """GIVEN a name with spaces WHEN slugified THEN unsafe runs collapse to a single _."""
        assert pdf_filename("Ana Perez") == "receivable-Ana_Perez.pdf"

    def test_falls_back_when_slug_empty(self) -> None:
        """GIVEN a punctuation-only name WHEN slugified THEN it falls back to 'person'."""
        assert pdf_filename("***") == "receivable-person.pdf"


class TestSpanishView:
    """The Spanish (es-AR) view carries es copy and 1.234,56 / DD/MM/YYYY formatting."""

    def test_copy_and_formatting(self) -> None:
        # GIVEN a rich person rendered in Spanish.
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY)

        # THEN the header + copy are Spanish and the emission date is DD/MM/YYYY.
        assert view.eyebrow == "Estado de cuenta entre amigos"
        assert view.account_of == "Cuenta de"
        assert view.tagline == "Sin intereses. Sin recargos."
        assert view.hero_label == "Saldo pendiente"
        assert view.details_title == "El detalle"
        assert view.balance_to_date_label == "Saldo a la fecha"
        assert view.date_line == "29/08/2026"
        # AND amounts use dot-thousands, comma-decimals (es-AR), no currency prefix.
        assert view.stat_total_value == "44.500,00"
        assert view.currency == "ARS"

    def test_hero_splits_integer_and_fraction(self) -> None:
        """GIVEN the outstanding WHEN built THEN the hero splits into large int + small decimals."""
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.hero_amount_main == "29.500"
        assert view.hero_amount_frac == ",00"


class TestEnglishView:
    """The English (en-US) view carries en copy and 1,234.56 / MM/DD/YYYY formatting."""

    def test_copy_and_formatting(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", today=_TODAY)

        assert view.eyebrow == "Statement between friends"
        assert view.account_of == "Account of"
        assert view.tagline == "No interest. No fees."
        assert view.hero_label == "Balance due"
        assert view.details_title == "The details"
        assert view.balance_to_date_label == "Balance to date"
        assert view.date_line == "08/29/2026"
        assert view.stat_total_value == "44,500.00"

    def test_hero_split(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", today=_TODAY)
        assert view.hero_amount_main == "29,500"
        assert view.hero_amount_frac == ".00"


class TestStats:
    """The three-stat bar sums consumed, paid and the authoritative outstanding (ADR-211)."""

    def test_three_stats(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        # Total consumido = Σ NON-pardoned amounts (the 7000 pardoned item is excluded).
        assert view.stat_total_value == "44.500,00"
        # Pagado hasta hoy = Σ payments.
        assert view.stat_paid_value == "15.000,00"
        # Pendiente = the authoritative outstanding.
        assert view.stat_pending_value == "29.500,00"

    def test_pending_is_authoritative_not_row_sum(self) -> None:
        """GIVEN outstanding diverges from row math (overpayment credit) THEN pending follows it."""
        person = _person(outstanding="123.45", items=(_item(amount="1000.00", remaining="1000.00"),))
        view = build_statement_view(person, owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.stat_pending_value == "123,45"
        assert view.balance_to_date_value == "123,45"


class TestFullHistoryLedger:
    """With full_history=True the ledger interleaves charges/payments (ADR-211, the opt-in mode)."""

    def test_running_balance_over_interleaved_events(self) -> None:
        # GIVEN the rich person WHEN built in full history THEN charges add and payments subtract.
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        rows = view.ledger_rows

        # 3 charges + 2 payments (the pardoned item is NOT in the ledger).
        assert view.full_history is True
        assert len(rows) == 5
        assert [(r.occurred_on, r.amount, r.balance, r.is_payment) for r in rows] == [
            ("26/08/2026", "24.500,00", "24.500,00", False),
            ("28/08/2026", "10.000,00", "34.500,00", False),
            ("28/08/2026", "10.000,00", "44.500,00", False),
            ("29/08/2026", f"{_MINUS} 10.000,00", "34.500,00", True),
            ("30/08/2026", f"{_MINUS} 5.000,00", "29.500,00", True),
        ]
        # AND the closing balance equals the authoritative outstanding.
        assert view.balance_to_date_value == "29.500,00"

    def test_payment_rows_are_labelled_and_flagged(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        payments = [r for r in view.ledger_rows if r.is_payment]
        assert all(r.detail == "Pago recibido" for r in payments)

    def test_payment_label_english(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", full_history=True, today=_TODAY)
        payments = [r for r in view.ledger_rows if r.is_payment]
        assert all(r.detail == "Payment received" for r in payments)

    def test_charge_uses_amount_not_remaining(self) -> None:
        """GIVEN a partly-paid charge THEN full history shows its full amount, not its remainder."""
        person = _person(
            outstanding="400.00",
            items=(_item(occurred_on=date(2026, 8, 1), amount="1000.00", remaining="400.00"),),
            payments=(_payment(occurred_on=date(2026, 8, 2), amount="600.00"),),
        )
        view = build_statement_view(person, owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        charge = view.ledger_rows[0]
        assert charge.amount == "1.000,00" and charge.balance == "1.000,00"

    def test_null_detail_renders_empty(self) -> None:
        person = _person(items=(_item(detail=None),))
        view = build_statement_view(person, owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        assert view.ledger_rows[0].detail == ""


class TestOutstandingLedger:
    """The default (outstanding-only) ledger lists only what is still owed (ADR-212)."""

    def test_lists_only_remaining_items_at_their_remaining_amount(self) -> None:
        # GIVEN a fully-paid, a partially-paid, an unpaid and a pardoned item.
        # WHEN the default (outstanding-only) view is built.
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)

        # THEN only the still-owed items appear, at their REMAINING amount, date-ascending, with a
        # cumulative-remaining Saldo (the fully-paid item and the pardoned item are dropped).
        assert view.full_history is False
        assert [(r.occurred_on, r.detail, r.amount, r.balance, r.is_payment) for r in view.ledger_rows] == [
            ("28/08/2026", "La Yerra", "4.000,00", "4.000,00", False),
            ("30/08/2026", "Aeropuerto taxi", "10.000,00", "14.000,00", False),
        ]

    def test_has_no_payment_rows(self) -> None:
        """GIVEN payments exist WHEN outstanding-only THEN no payment (−) rows are emitted."""
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert all(row.is_payment is False for row in view.ledger_rows)
        assert _MINUS not in "".join(row.amount for row in view.ledger_rows)

    def test_closing_balance_is_the_authoritative_outstanding(self) -> None:
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.ledger_rows[-1].balance == "14.000,00"
        assert view.balance_to_date_value == "14.000,00"

    def test_stats_stay_all_time_in_outstanding_mode(self) -> None:
        """GIVEN outstanding-only THEN the 3-stat bar still reports the all-time context."""
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.stat_total_value == "44.500,00"  # Σ non-pardoned amounts, all time.
        assert view.stat_paid_value == "30.500,00"  # Σ payments, all time.
        assert view.stat_pending_value == "14.000,00"  # authoritative outstanding.

    def test_covered_box_retained_in_outstanding_mode(self) -> None:
        """GIVEN a pardoned item WHEN outstanding-only THEN the covered box is still shown."""
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.show_covered is True
        assert [(r.detail, r.amount) for r in view.covered_rows] == [("Gloria", "7.000,00")]

    def test_english_amounts_and_rows(self) -> None:
        """GIVEN en-US WHEN outstanding-only THEN remaining amounts use 1,234.56 grouping."""
        view = build_statement_view(_settled_person(), owner_name=_OWNER, lang="en", today=_TODAY)
        assert [(r.amount, r.balance) for r in view.ledger_rows] == [
            ("4,000.00", "4,000.00"),
            ("10,000.00", "14,000.00"),
        ]

    def test_null_detail_renders_empty(self) -> None:
        """GIVEN an owed item with no detail THEN its outstanding row shows an empty detail."""
        person = _person(outstanding="1000.00", items=(_item(detail=None),))
        view = build_statement_view(person, owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.ledger_rows[0].detail == ""

    def test_empty_when_everything_is_paid_or_pardoned(self) -> None:
        """GIVEN no item still owes THEN the outstanding ledger is empty (the empty-state case)."""
        person = _person(
            outstanding="0.00",
            items=(
                _item(amount="1000.00", allocated="1000.00", remaining="0.00"),  # fully paid, dropped.
                _item(amount="500.00", remaining="500.00", pardoned=True),  # pardoned, dropped.
            ),
        )
        view = build_statement_view(person, owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.ledger_rows == ()
        assert view.empty_state == "Estás al día. No hay nada pendiente."

    def test_empty_state_english_copy(self) -> None:
        view = build_statement_view(_person(outstanding="0.00"), owner_name=_OWNER, lang="en", today=_TODAY)
        assert view.empty_state == "You are all square. Nothing outstanding."


class TestCoveredBox:
    """The 'Lo pagué yo' covered box lists pardoned items, else is omitted (ADR-210/211)."""

    def test_present_with_pardoned_item(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.show_covered is True
        assert len(view.covered_rows) == 1
        row = view.covered_rows[0]
        assert (row.occurred_on, row.detail, row.amount) == ("26/08/2026", "Gloria", "7.000,00")
        assert view.covered_title == "Lo pagué yo, no te lo cobro"
        assert view.covered_note.startswith("Esta la puse yo")

    def test_absent_without_pardoned_items(self) -> None:
        view = build_statement_view(_person(items=(_item(),)), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.show_covered is False
        assert view.covered_rows == ()

    def test_fully_paid_pardoned_item_excluded(self) -> None:
        """GIVEN a pardoned item with nothing left to forgive THEN it is not shown as covered."""
        person = _person(items=(_item(remaining="0.00", pardoned=True),))
        view = build_statement_view(person, owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.show_covered is False


class TestFooter:
    """The footer is signed with the owner, or drops the owner gracefully when unknown."""

    def test_owner_present(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.footer_issued == "Emitido por Tomas Sanchez"
        assert view.footer_complaints == "Reclamos en persona, durante una cena"

    def test_owner_absent(self) -> None:
        view = build_statement_view(_rich_person(), owner_name="  ", lang="es", today=_TODAY)
        assert view.footer_issued == "Emitido"

    def test_owner_english(self) -> None:
        view = build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", today=_TODAY)
        assert view.footer_issued == "Issued by Tomas Sanchez"
        assert view.footer_complaints == "Complaints in person, over dinner"


class TestNegativeOutstanding:
    """A confirmed overpayment can drive the outstanding negative (ADR-206)."""

    def test_hero_split_keeps_sign(self) -> None:
        view = build_statement_view(_person(outstanding="-500.00"), owner_name=_OWNER, lang="es", today=_TODAY)
        assert view.hero_amount_main == "-500" and view.hero_amount_frac == ",00"


class TestRenderHtml:
    """The template renders both content modes into HTML (ADR-211/212)."""

    def test_spanish_copy_present(self) -> None:
        html = render_statement_html(
            build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        )
        for fragment in (
            "Estado de cuenta entre amigos",
            "Cuenta de",
            "Maria Gabriela",
            "Sin intereses. Sin recargos.",
            "Saldo pendiente",
            "Total consumido",
            "El detalle",
            "Pago recibido",
            "Saldo a la fecha",
            "Lo pagué yo, no te lo cobro",
            "Emitido por Tomas Sanchez",
        ):
            assert fragment in html, fragment

    def test_english_copy_present(self) -> None:
        html = render_statement_html(
            build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", full_history=True, today=_TODAY)
        )
        for fragment in (
            "Statement between friends",
            "Account of",
            "No interest. No fees.",
            "Balance due",
            "Total spent",
            "The details",
            "Payment received",
            "Balance to date",
            "I covered this, on me",
            "Issued by Tomas Sanchez",
        ):
            assert fragment in html, fragment

    def test_outstanding_only_hides_payments_and_shows_remaining(self) -> None:
        """GIVEN the default mode THEN payment rows are hidden and owed items show their remaining."""
        html = render_statement_html(
            build_statement_view(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)
        )
        # THEN no payment history (label nor minus) leaks into the default document.
        assert "Pago recibido" not in html
        assert _MINUS not in html
        # AND the still-owed items appear at their remaining amount, closing on the outstanding.
        for fragment in ("La Yerra", "4.000,00", "Aeropuerto taxi", "10.000,00", "Saldo a la fecha"):
            assert fragment in html, fragment
        # AND the covered box is retained even in the outstanding-only default (ADR-210/212).
        assert "Lo pagué yo, no te lo cobro" in html

    @pytest.mark.parametrize("lang", ["es", "en"])
    def test_empty_state_rendered_when_nothing_owed(self, lang: Locale) -> None:
        """GIVEN nothing is owed WHEN outstanding-only THEN the calm empty state replaces the table."""
        empty_copy = {"es": "Estás al día. No hay nada pendiente.", "en": "You are all square. Nothing outstanding."}
        html = render_statement_html(
            build_statement_view(_person(outstanding="0.00"), owner_name=_OWNER, lang=lang, today=_TODAY)
        )
        assert empty_copy[lang] in html
        assert '<table class="ledger">' not in html  # the ledger table is not rendered when empty.

    @pytest.mark.parametrize("lang", ["es", "en"])
    @pytest.mark.parametrize("full_history", [False, True])
    def test_no_em_or_en_dash(self, lang: Locale, full_history: bool) -> None:
        """GIVEN either locale and either mode THEN no em/en dash appears (only the real minus)."""
        html = render_statement_html(
            build_statement_view(
                _settled_person(), owner_name=_OWNER, lang=lang, full_history=full_history, today=_TODAY
            )
        )
        assert _EM_DASH not in html
        assert _EN_DASH not in html

    def test_payment_amount_uses_real_minus(self) -> None:
        html = render_statement_html(
            build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)
        )
        assert f"{_MINUS} 10.000,00" in html

    def test_page_counter_words_spanish(self) -> None:
        html = render_statement_html(build_statement_view(_rich_person(), owner_name=_OWNER, lang="es", today=_TODAY))
        assert '"Página " counter(page) " de " counter(pages)' in html

    def test_page_counter_words_english(self) -> None:
        html = render_statement_html(build_statement_view(_rich_person(), owner_name=_OWNER, lang="en", today=_TODAY))
        assert '"Page " counter(page) " of " counter(pages)' in html

    def test_covered_box_omitted_when_absent(self) -> None:
        html = render_statement_html(
            build_statement_view(_person(items=(_item(),)), owner_name=_OWNER, lang="es", today=_TODAY)
        )
        assert "Lo pagué yo, no te lo cobro" not in html

    def test_debtor_name_is_escaped(self) -> None:
        """GIVEN a name with markup THEN autoescaping neutralizes it in the HTML."""
        html = render_statement_html(
            build_statement_view(_person(name="<script>x</script>"), owner_name=_OWNER, lang="es", today=_TODAY)
        )
        assert "<script>x</script>" not in html
        assert "&lt;script&gt;" in html


class TestBuildStatementPdf:
    """The composed entry point wires view -> HTML -> the native WeasyPrint adapter (ADR-211)."""

    def test_composes_and_delegates_to_weasyprint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # GIVEN the native boundary is stubbed (WeasyPrint's GTK stack is not present here).
        captured: dict[str, str] = {}

        def _fake_html_to_pdf(html: str) -> bytes:
            captured["html"] = html
            return b"%PDF-stub"

        monkeypatch.setattr(receivable_statement, "_html_to_pdf", _fake_html_to_pdf)

        # WHEN the composed entry point runs (default: outstanding-only).
        pdf = build_statement_pdf(_settled_person(), owner_name=_OWNER, lang="es", today=_TODAY)

        # THEN it returns the adapter's bytes, having first rendered the real template HTML, and
        # the default mode hides the payment history.
        assert pdf == b"%PDF-stub"
        assert "Estado de cuenta entre amigos" in captured["html"]
        assert "Pago recibido" not in captured["html"]

    def test_full_history_flag_flows_into_the_html(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """GIVEN full_history=True WHEN the entry point runs THEN the payment rows reach the HTML."""
        captured: dict[str, str] = {}

        def _fake_html_to_pdf(html: str) -> bytes:
            captured["html"] = html
            return b"%PDF-stub"

        monkeypatch.setattr(receivable_statement, "_html_to_pdf", _fake_html_to_pdf)

        # WHEN full history is requested for the settled person.
        build_statement_pdf(_settled_person(), owner_name=_OWNER, lang="es", full_history=True, today=_TODAY)

        # THEN the full ledger's payment rows appear (they are hidden by the default mode).
        assert "Pago recibido" in captured["html"]
