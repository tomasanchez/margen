"""Unit tests for the pure, localized receivable-PDF builders (ADR-209).

These exercise the I/O-free builders with no ``fitz``: the locale normalization contract,
the two-language labels and number/date formatting (es-AR ``1.234,56`` + ``DD/MM/YYYY``
vs. en-US ``1,234.56`` + ``MM/DD/YYYY``, ARS either way), the authoritative outstanding
total, the v1 outstanding-only filtering (zero- and negative-remainder items excluded),
null detail rendering, the icons attached to the layout, pagination, the absolute absence
of em/en dashes in every rendered string, and the download filename slug. Rendering to PDF
bytes (and the vector icons) is covered end-to-end by the route.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

import pytest

from margen_api.service_layer.receivable_pdf import (
    IconKind,
    Locale,
    PdfPage,
    build_content,
    build_layout,
    normalize_locale,
    pdf_filename,
)
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableItemReadModel,
    ReceivablePaymentReadModel,
)

_PERSON_ID = UUID("11111111-1111-4111-8111-111111111111")
_ITEM_ID = UUID("22222222-2222-4222-8222-222222222222")
_CREATED = datetime(2026, 1, 1)


def _payment(*, occurred_on: date = date(2026, 8, 20), amount: str = "300.00") -> ReceivablePaymentReadModel:
    """Build a payback read model with a sensible default amount."""
    return ReceivablePaymentReadModel(occurred_on=occurred_on, amount=Decimal(amount))


def _item(
    *,
    occurred_on: date = date(2026, 8, 24),
    amount: str = "1000.00",
    detail: str | None = "lunch",
    allocated: str = "0.00",
    remaining: str = "1000.00",
    pardoned: bool = False,
) -> ReceivableItemReadModel:
    """Build a receivable item read model with sensible outstanding defaults."""
    return ReceivableItemReadModel(
        id=_ITEM_ID,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        detail=detail,
        allocated=Decimal(allocated),
        remaining=Decimal(remaining),
        pardoned=pardoned,
    )


def _person(
    *,
    name: str = "Ana Perez",
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


class TestNormalizeLocale:
    """normalize_locale maps a raw ``lang`` query value to a supported locale (ADR-209)."""

    @pytest.mark.parametrize("raw", ["en", "EN", "en-US", "  en_us  ", "English"])
    def test_english_tags_resolve_to_en(self, raw: str):
        """
        GIVEN a raw value that starts with an English tag (any case / whitespace)
        WHEN it is normalized
        THEN it resolves to 'en'
        """
        # WHEN / THEN
        assert normalize_locale(raw) == "en"

    @pytest.mark.parametrize("raw", ["es", "es-AR", "ES", "", "fr", "xx", None])
    def test_spanish_and_unknown_fall_back_to_es(self, raw: str | None):
        """
        GIVEN a Spanish tag, an unknown language, empty, or None
        WHEN it is normalized
        THEN it falls back to the 'es' default (ADR-102)
        """
        # WHEN / THEN
        assert normalize_locale(raw) == "es"


class TestBuildContentSpanish:
    """The pure es-AR content model backing the PDF (ADR-209, amended)."""

    def test_labels_are_spanish_and_friendly(self):
        """
        GIVEN a person and the Spanish locale
        WHEN the content is assembled
        THEN the title, intro and labels use plain, informal es-AR copy with the name
        """
        # WHEN
        content = build_content(_person(name="María Emilia"), "es")

        # THEN
        assert content.title == "Cuenta de María Emilia"
        assert content.intro == "Hola María Emilia, este es un resumen de lo que quedó pendiente."
        assert content.total_label == "Total adeudado:"
        assert content.column_headers == ("Fecha", "Monto", "Detalle")

    def test_amounts_use_es_ar_grouping_with_ars_prefix(self):
        """
        GIVEN a large amount and the Spanish locale
        WHEN the content is assembled
        THEN amounts render as 'ARS 1.234.567,89' (dot thousands, comma decimal)
        """
        # GIVEN
        person = _person(outstanding="1234567.89", items=(_item(remaining="1234567.89"),))

        # WHEN
        content = build_content(person, "es")

        # THEN
        assert content.total_amount == "ARS 1.234.567,89"
        assert content.rows[0].amount == "ARS 1.234.567,89"

    def test_dates_are_es_ar_day_month_year(self):
        """
        GIVEN an item incurred on 2026-08-24 and the Spanish locale
        WHEN the content is assembled
        THEN its row date is the es-AR 'DD/MM/YYYY' string
        """
        # WHEN
        content = build_content(_person(items=(_item(occurred_on=date(2026, 8, 24)),)), "es")

        # THEN
        assert content.rows[0].occurred_on == "24/08/2026"

    def test_spanish_is_the_default_locale(self):
        """
        GIVEN no explicit locale
        WHEN the content is assembled
        THEN it defaults to Spanish (ADR-102)
        """
        # WHEN
        content = build_content(_person(name="Ana"))

        # THEN
        assert content.title == "Cuenta de Ana"


class TestBuildContentEnglish:
    """The pure en-US content model backing the PDF (ADR-209, amended)."""

    def test_labels_are_english_and_friendly(self):
        """
        GIVEN a person and the English locale
        WHEN the content is assembled
        THEN the title, intro and labels use plain, informal en-US copy with the name
        """
        # WHEN
        content = build_content(_person(name="María Emilia"), "en")

        # THEN
        assert content.title == "What María Emilia owes"
        assert content.intro == "Hi María Emilia, here is a quick summary of what is still pending."
        assert content.total_label == "Total owed:"
        assert content.column_headers == ("Date", "Amount", "Detail")

    def test_amounts_use_en_us_grouping_with_ars_prefix(self):
        """
        GIVEN a large amount and the English locale
        WHEN the content is assembled
        THEN amounts render as 'ARS 1,234,567.89' (comma thousands, dot decimal)
        """
        # GIVEN
        person = _person(outstanding="1234567.89", items=(_item(remaining="1234567.89"),))

        # WHEN
        content = build_content(person, "en")

        # THEN
        assert content.total_amount == "ARS 1,234,567.89"
        assert content.rows[0].amount == "ARS 1,234,567.89"

    def test_dates_are_en_us_month_day_year(self):
        """
        GIVEN an item incurred on 2026-08-24 and the English locale
        WHEN the content is assembled
        THEN its row date is the en-US 'MM/DD/YYYY' string
        """
        # WHEN
        content = build_content(_person(items=(_item(occurred_on=date(2026, 8, 24)),)), "en")

        # THEN
        assert content.rows[0].occurred_on == "08/24/2026"


class TestBuildContentBehavior:
    """Locale-independent content behavior: filtering, authority, null detail (ADR-209)."""

    def test_uses_item_remaining_as_the_row_amount(self):
        """
        GIVEN a partially-paid item (amount 1000, remaining 400)
        WHEN the content is assembled
        THEN the row shows the still-owed remaining, not the original amount (ADR-209)
        """
        # GIVEN
        person = _person(
            outstanding="400.00",
            items=(_item(amount="1000.00", allocated="600.00", remaining="400.00"),),
        )

        # WHEN
        content = build_content(person, "en")

        # THEN
        assert content.rows[0].amount == "ARS 400.00"

    def test_null_detail_renders_empty(self):
        """
        GIVEN an outstanding item with no detail
        WHEN the content is assembled
        THEN its row detail is the empty string (never the literal 'None')
        """
        # WHEN
        content = build_content(_person(items=(_item(detail=None),)), "es")

        # THEN
        assert content.rows[0].detail == ""

    def test_excludes_zero_and_negative_remainder_items(self):
        """
        GIVEN a settled (remaining 0), an overpaid (remaining -50) and one live item
        WHEN the content is assembled
        THEN only the live outstanding item is shown (v1 outstanding-only, ADR-209)
        """
        # GIVEN
        settled = _item(amount="1000.00", allocated="1000.00", remaining="0.00", detail="settled")
        overpaid = _item(amount="1000.00", allocated="1050.00", remaining="-50.00", detail="overpaid")
        live = _item(amount="700.00", remaining="700.00", detail="live")
        person = _person(outstanding="650.00", items=(settled, overpaid, live))

        # WHEN
        content = build_content(person, "en")

        # THEN — only the positive-remainder row survives.
        assert [row.detail for row in content.rows] == ["live"]
        assert content.rows[0].amount == "ARS 700.00"

    def test_outstanding_total_is_authoritative_from_read_model(self):
        """
        GIVEN a person whose outstanding total diverges from the visible rows' sum
        WHEN the content is assembled
        THEN the total is taken from the read model, not re-derived from the rows (ADR-206)
        """
        # GIVEN — an overpaid item is hidden, so the shown row (700) != total (650).
        overpaid = _item(remaining="-50.00", detail="overpaid")
        live = _item(remaining="700.00", detail="live")
        person = _person(outstanding="650.00", items=(overpaid, live))

        # WHEN
        content = build_content(person, "es")

        # THEN
        assert content.total_amount == "ARS 650,00"
        assert len(content.rows) == 1

    def test_empty_person_has_no_rows(self):
        """
        GIVEN a person with no items
        WHEN the content is assembled
        THEN there are no rows and the total still renders
        """
        content = build_content(_person(outstanding="0.00", items=()), "en")
        assert content.rows == ()
        assert content.total_amount == "ARS 0.00"


class TestCoveredSection:
    """The "Covered by you" content for pardoned items (ADR-210)."""

    def test_pardoned_items_move_to_covered_rows_out_of_outstanding(self):
        """
        GIVEN a live item and a pardoned item
        WHEN the content is assembled
        THEN the live one is an outstanding row and the pardoned one is a covered row
        """
        # GIVEN
        live = _item(remaining="1000.00", detail="rent")
        forgiven = _item(remaining="500.00", detail="loan", pardoned=True)
        person = _person(outstanding="1000.00", items=(live, forgiven))

        # WHEN
        content = build_content(person, "en")

        # THEN
        assert [row.detail for row in content.rows] == ["rent"]
        assert [row.detail for row in content.covered_rows] == ["loan"]

    def test_covered_total_sums_covered_amounts_localized(self):
        """
        GIVEN two pardoned items covering 500 and 1500
        WHEN the content is assembled in each locale
        THEN the covered total is their sum, formatted for the locale (ADR-210)
        """
        # GIVEN
        person = _person(
            outstanding="0.00",
            items=(
                _item(remaining="500.00", detail="a", pardoned=True),
                _item(remaining="1500.00", detail="b", pardoned=True),
            ),
        )

        # WHEN / THEN
        assert build_content(person, "en").covered_total == "ARS 2,000.00"
        assert build_content(person, "es").covered_total == "ARS 2.000,00"

    def test_covered_row_amount_is_the_covered_remainder(self):
        """
        GIVEN a partially-paid then pardoned item (amount 1000, remaining 400)
        WHEN the content is assembled
        THEN its covered row shows the 400 still forgiven, not the original amount
        """
        # GIVEN
        forgiven = _item(amount="1000.00", allocated="600.00", remaining="400.00", pardoned=True)
        person = _person(outstanding="0.00", items=(forgiven,))

        # WHEN
        content = build_content(person, "en")

        # THEN
        assert content.covered_rows[0].amount == "ARS 400.00"

    def test_fully_paid_pardoned_item_has_nothing_to_cover(self):
        """
        GIVEN a pardoned item that was already fully paid (remaining 0)
        WHEN the content is assembled
        THEN it is not shown as covered (nothing to forgive, ADR-210)
        """
        # GIVEN
        settled = _item(amount="1000.00", allocated="1000.00", remaining="0.00", pardoned=True)
        person = _person(outstanding="0.00", items=(settled,))

        # WHEN
        content = build_content(person, "en")

        # THEN
        assert content.covered_rows == ()

    def test_covered_labels_use_the_owner_name(self):
        """
        GIVEN a person with a pardoned item and a known owner name
        WHEN the content is assembled in each locale
        THEN the covered title and total carry the OWNER'S name, not "you" (ADR-209 amended)
        """
        # GIVEN
        person = _person(outstanding="0.00", items=(_item(remaining="500.00", pardoned=True),))

        # WHEN
        es = build_content(person, "es", "Tomas Sanchez")
        en = build_content(person, "en", "Tomas Sanchez")

        # THEN
        assert (es.covered_title, es.covered_total_label) == (
            "Cubierto por Tomas Sanchez",
            "Total cubierto por Tomas Sanchez:",
        )
        assert (en.covered_title, en.covered_total_label) == (
            "Covered by Tomas Sanchez",
            "Tomas Sanchez covered:",
        )

    @pytest.mark.parametrize("owner_name", ["", "   "])
    def test_covered_labels_drop_suffix_when_owner_unknown(self, owner_name: str):
        """
        GIVEN a person with a pardoned item but no derivable owner name
        WHEN the content is assembled in each locale
        THEN the "by {owner}" suffix is dropped gracefully (ADR-209 amended)
        """
        # GIVEN
        person = _person(outstanding="0.00", items=(_item(remaining="500.00", pardoned=True),))

        # WHEN
        es = build_content(person, "es", owner_name)
        en = build_content(person, "en", owner_name)

        # THEN
        assert (es.covered_title, es.covered_total_label) == ("Cubierto", "Total cubierto:")
        assert (en.covered_title, en.covered_total_label) == ("Covered", "Covered:")


class TestPaymentsContent:
    """The "Payments received" content for the person's paybacks (ADR-209)."""

    def test_payment_rows_are_localized_date_and_amount(self):
        """
        GIVEN a payback of 1.234,56 on 2026-08-24
        WHEN the content is assembled in each locale
        THEN the payment row date + amount use the locale's formatting (ADR-209)
        """
        # GIVEN
        person = _person(
            outstanding="0.00",
            items=(),
            payments=(_payment(occurred_on=date(2026, 8, 24), amount="1234.56"),),
        )

        # WHEN / THEN
        es = build_content(person, "es")
        en = build_content(person, "en")
        assert (es.payment_rows[0].occurred_on, es.payment_rows[0].amount) == ("24/08/2026", "ARS 1.234,56")
        assert (en.payment_rows[0].occurred_on, en.payment_rows[0].amount) == ("08/24/2026", "ARS 1,234.56")

    def test_payments_total_sums_all_payments_localized(self):
        """
        GIVEN two paybacks (300 + 500) regardless of source
        WHEN the content is assembled in each locale
        THEN the payments total is their sum, formatted for the locale (ADR-209)
        """
        # GIVEN
        person = _person(outstanding="0.00", items=(), payments=(_payment(amount="300.00"), _payment(amount="500.00")))

        # WHEN / THEN
        assert build_content(person, "en").payments_total == "ARS 800.00"
        assert build_content(person, "es").payments_total == "ARS 800,00"

    def test_payment_column_headers_are_date_and_amount(self):
        """
        GIVEN any person
        WHEN the content is assembled in each locale
        THEN the payment section has just the localized date + amount column headers
        """
        assert build_content(_person(), "es").payment_column_headers == ("Fecha", "Monto")
        assert build_content(_person(), "en").payment_column_headers == ("Date", "Amount")

    def test_no_payments_yields_no_payment_rows(self):
        """
        GIVEN a person with no paybacks
        WHEN the content is assembled
        THEN there are no payment rows (the section is omitted downstream, ADR-209)
        """
        assert build_content(_person(items=(_item(),)), "en").payment_rows == ()


class TestBuildLayout:
    """Pagination, positioning and icons of the content into pages (pure, ADR-209)."""

    def _texts(self, page: PdfPage) -> list[str]:
        return [span.text for span in page.spans]

    def _icon_kinds(self, page: PdfPage) -> list[IconKind]:
        return [icon.kind for icon in page.icons]

    def test_single_page_carries_header_block_and_rows(self):
        """
        GIVEN a person with a couple of outstanding items and the Spanish locale
        WHEN the layout is built
        THEN a single page holds the title, intro, total and the rows
        """
        # GIVEN
        person = _person(
            name="Ana Perez",
            outstanding="1500.00",
            items=(_item(remaining="1000.00"), _item(remaining="500.00")),
        )

        # WHEN
        pages = build_layout(person, "es")

        # THEN
        assert len(pages) == 1
        texts = self._texts(pages[0])
        assert "Cuenta de Ana Perez" in texts
        assert "Hola Ana Perez, este es un resumen de lo que quedó pendiente." in texts
        assert "Total adeudado: ARS 1.500,00" in texts
        assert "Fecha" in texts  # column headers present

    def test_layout_attaches_field_icons(self):
        """
        GIVEN a person with an outstanding item
        WHEN the layout is built
        THEN the page carries the person, money, calendar and note icons beside the fields
        """
        # GIVEN
        person = _person(items=(_item(),))

        # WHEN
        pages = build_layout(person, "en")

        # THEN — every field icon is present (person + total + the three column icons).
        kinds = self._icon_kinds(pages[0])
        assert IconKind.PERSON in kinds
        assert IconKind.MONEY in kinds
        assert IconKind.CALENDAR in kinds
        assert IconKind.NOTE in kinds

    def test_paginates_long_item_lists_repeating_headers_and_icons(self):
        """
        GIVEN a person with many outstanding items (more than fit on one page)
        WHEN the layout is built
        THEN the rows spill onto a second page and the column headers + icons repeat there
        """
        # GIVEN — 40 items overflow the single-page row budget.
        items = tuple(_item(remaining=f"{i + 1}.00", detail=f"item {i}") for i in range(40))
        person = _person(outstanding="820.00", items=items)

        # WHEN
        pages = build_layout(person, "en")

        # THEN — two pages, each carrying its own 'Date' column header + calendar icon.
        assert len(pages) == 2
        assert "Date" in self._texts(pages[0])
        assert "Date" in self._texts(pages[1])
        assert IconKind.CALENDAR in self._icon_kinds(pages[1])
        # AND — the title / person icon only appears on the first page.
        assert "What Ana Perez owes" in self._texts(pages[0])
        assert "What Ana Perez owes" not in self._texts(pages[1])
        assert IconKind.PERSON not in self._icon_kinds(pages[1])

    @pytest.mark.parametrize(
        ("locale", "title", "total"),
        [
            ("es", "Cubierto por Tomas Sanchez", "Total cubierto por Tomas Sanchez: ARS 1.500,00"),
            ("en", "Covered by Tomas Sanchez", "Tomas Sanchez covered: ARS 1,500.00"),
        ],
    )
    def test_covered_section_renders_owner_title_and_total(self, locale: Locale, title: str, total: str):
        """
        GIVEN a person with an outstanding item and two pardoned items (500 + 1000)
        WHEN the layout is built in each locale with a known owner name
        THEN the page carries the owner-named covered title and covered total (ADR-209 amended)
        """
        # GIVEN
        person = _person(
            name="Ana Perez",
            outstanding="700.00",
            items=(
                _item(remaining="700.00", detail="live"),
                _item(remaining="500.00", detail="a", pardoned=True),
                _item(remaining="1000.00", detail="b", pardoned=True),
            ),
        )

        # WHEN
        pages = build_layout(person, locale, "Tomas Sanchez")

        # THEN
        texts = self._texts(pages[0])
        assert title in texts
        assert total in texts

    def test_covered_section_omitted_when_no_pardoned_items(self):
        """
        GIVEN a person with only outstanding items
        WHEN the layout is built
        THEN neither the covered title nor total label appears anywhere (ADR-210)
        """
        # GIVEN
        person = _person(outstanding="1000.00", items=(_item(remaining="1000.00"),))

        # WHEN
        pages = build_layout(person, "en", "Tomas Sanchez")

        # THEN
        all_texts = [text for page in pages for text in self._texts(page)]
        assert not any("Covered" in text for text in all_texts)

    @pytest.mark.parametrize(
        ("locale", "title", "total"),
        [
            ("es", "Pagos recibidos", "Total pagado: ARS 800,00"),
            ("en", "Payments received", "Total paid: ARS 800.00"),
        ],
    )
    def test_payments_section_renders_title_and_total(self, locale: Locale, title: str, total: str):
        """
        GIVEN a person with an outstanding item and two paybacks (300 + 500)
        WHEN the layout is built in each locale
        THEN the page carries the localized "Payments received" title and total paid (ADR-209)
        """
        # GIVEN
        person = _person(
            name="Ana Perez",
            outstanding="1000.00",
            items=(_item(remaining="1000.00", detail="rent"),),
            payments=(_payment(amount="300.00"), _payment(amount="500.00")),
        )

        # WHEN
        pages = build_layout(person, locale)

        # THEN
        texts = self._texts(pages[0])
        assert title in texts
        assert total in texts

    def test_payments_section_omitted_when_no_payments(self):
        """
        GIVEN a person with items but no paybacks
        WHEN the layout is built
        THEN neither the payments title nor total label appears anywhere (ADR-209)
        """
        # GIVEN
        person = _person(outstanding="1000.00", items=(_item(remaining="1000.00"),))

        # WHEN
        pages = build_layout(person, "en")

        # THEN
        all_texts = [text for page in pages for text in self._texts(page)]
        assert not any("Payments received" in text for text in all_texts)
        assert not any("Total paid" in text for text in all_texts)

    def test_payments_rows_paginate_across_pages(self):
        """
        GIVEN a person with many paybacks (more than fit on one page)
        WHEN the layout is built
        THEN the payment rows spill onto a second page repeating the column headers (ADR-209)
        """
        # GIVEN — 60 paybacks overflow the single-page row budget.
        payments = tuple(_payment(amount=f"{i + 1}.00") for i in range(60))
        person = _person(outstanding="0.00", items=(), payments=payments)

        # WHEN
        pages = build_layout(person, "en")

        # THEN — the payment rows span two pages, each carrying the Date column header.
        assert len(pages) == 2
        assert "Payments received" in self._texts(pages[0])
        assert "Date" in self._texts(pages[1])

    def test_covered_rows_paginate_across_pages(self):
        """
        GIVEN a person with many pardoned items (more than fit on one page)
        WHEN the layout is built
        THEN the covered rows spill onto a second page repeating the column headers
        """
        # GIVEN — 60 pardoned items overflow the single-page row budget.
        items = tuple(_item(remaining=f"{i + 1}.00", detail=f"forgiven {i}", pardoned=True) for i in range(60))
        person = _person(outstanding="0.00", items=items)

        # WHEN
        pages = build_layout(person, "en", "Tomas Sanchez")

        # THEN — the covered rows span two pages, each carrying the Date column header.
        assert len(pages) == 2
        assert "Covered by Tomas Sanchez" in self._texts(pages[0])
        assert "Date" in self._texts(pages[1])


class TestNoDashes:
    """The rendered document contains no em-dashes or en-dashes anywhere (ADR-209)."""

    @pytest.mark.parametrize("locale", ["es", "en"])
    def test_no_em_or_en_dashes_in_any_rendered_string(self, locale: Locale):
        """
        GIVEN a person with a null-detail item, rendered in each locale
        WHEN every text span across the layout is inspected
        THEN not a single string contains an em-dash or an en-dash
        """
        # GIVEN — a realistic person including a null-detail row, a pardoned item AND paybacks,
        # so the owner-named covered section AND the "Payments received" section strings are
        # inspected by the guard too (ADR-209 amended, ADR-210). An owner name is supplied so
        # the covered heading/total (which now interpolate it) are inspected as well.
        person = _person(
            name="María Peña",
            outstanding="9999.99",
            items=(
                _item(detail="Café", remaining="500.00"),
                _item(detail=None, remaining="9499.99"),
                _item(detail="Préstamo", remaining="750.00", pardoned=True),
            ),
            payments=(_payment(amount="300.00"), _payment(amount="250.50")),
        )

        # WHEN
        pages = build_layout(person, locale, "Tomás Núñez")

        # THEN - no em-dash (U+2014) and no en-dash (U+2013) in any placed string.
        em_dash, en_dash = chr(0x2014), chr(0x2013)
        for page in pages:
            for span in page.spans:
                assert em_dash not in span.text and en_dash not in span.text


class TestPdfFilename:
    """The attachment filename slug (ADR-209)."""

    def test_slugifies_spaces_and_punctuation(self):
        """
        GIVEN a person name with spaces and punctuation
        WHEN the filename is built
        THEN unsafe runs collapse to single underscores inside a receivable-*.pdf name
        """
        assert pdf_filename("Ana Pérez!!") == "receivable-Ana_P_rez.pdf"

    def test_keeps_safe_characters(self):
        """
        GIVEN a name made only of filename-safe characters
        WHEN the filename is built
        THEN it is preserved verbatim
        """
        assert pdf_filename("Juan-01") == "receivable-Juan-01.pdf"

    def test_falls_back_when_slug_is_empty(self):
        """
        GIVEN a name that slugifies to nothing (only unsafe characters)
        WHEN the filename is built
        THEN it falls back to the generic 'person' slug
        """
        assert pdf_filename("¡!!") == "receivable-person.pdf"
