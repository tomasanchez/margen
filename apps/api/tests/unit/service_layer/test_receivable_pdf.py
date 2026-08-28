"""Unit tests for the pure receivable-PDF content assembly and layout (ADR-209).

These exercise the I/O-free builders with no ``fitz``: the deliberate English (en-US)
labels and number formatting (``ARS 1,234.56``), the en-US ``MM/DD/YYYY`` dates, the
authoritative outstanding total, the v1 outstanding-only filtering (zero- and
negative-remainder items excluded), null detail rendering, pagination across pages, and
the download filename slug. Rendering to PDF bytes is covered end-to-end by the route.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from margen_api.service_layer.receivable_pdf import (
    build_content,
    build_layout,
    pdf_filename,
)
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableItemReadModel,
)

_PERSON_ID = UUID("11111111-1111-4111-8111-111111111111")
_ITEM_ID = UUID("22222222-2222-4222-8222-222222222222")
_CREATED = datetime(2026, 1, 1)


def _item(
    *,
    occurred_on: date = date(2026, 8, 24),
    amount: str = "1000.00",
    detail: str | None = "lunch",
    allocated: str = "0.00",
    remaining: str = "1000.00",
) -> ReceivableItemReadModel:
    """Build a receivable item read model with sensible outstanding defaults."""
    return ReceivableItemReadModel(
        id=_ITEM_ID,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        detail=detail,
        allocated=Decimal(allocated),
        remaining=Decimal(remaining),
    )


def _person(
    *,
    name: str = "Ana Perez",
    outstanding: str = "1000.00",
    items: tuple[ReceivableItemReadModel, ...] = (),
) -> PersonDetailReadModel:
    """Build a person-detail read model wrapping the given items."""
    return PersonDetailReadModel(
        id=_PERSON_ID,
        name=name,
        created_at=_CREATED,
        outstanding=Decimal(outstanding),
        items=items,
    )


class TestBuildContent:
    """The pure en-US content model backing the PDF (ADR-209)."""

    def test_formats_amounts_en_us_with_ars_prefix(self):
        """
        GIVEN an item whose remaining is 1234.56 and a matching outstanding total
        WHEN the content is assembled
        THEN both render as 'ARS 1,234.56' — en-US grouping with the ARS prefix
        """
        # GIVEN
        person = _person(
            outstanding="1234.56",
            items=(_item(amount="1234.56", remaining="1234.56"),),
        )

        # WHEN
        content = build_content(person)

        # THEN
        assert content.outstanding_amount == "ARS 1,234.56"
        assert content.rows[0].amount == "ARS 1,234.56"

    def test_formats_thousands_and_labels_are_english(self):
        """
        GIVEN a large outstanding total
        WHEN the content is assembled
        THEN the labels are English and the total groups thousands with commas
        """
        # GIVEN
        person = _person(outstanding="1500000.00", items=(_item(remaining="1500000.00"),))

        # WHEN
        content = build_content(person)

        # THEN
        assert content.title == "Outstanding Balance Statement"
        assert content.outstanding_label == "Total outstanding:"
        assert content.column_headers == ("Date", "Amount", "Detail")
        assert content.outstanding_amount == "ARS 1,500,000.00"

    def test_dates_are_en_us_month_day_year(self):
        """
        GIVEN an item incurred on 2026-08-24
        WHEN the content is assembled
        THEN its row date is the en-US 'MM/DD/YYYY' string
        """
        # WHEN
        content = build_content(_person(items=(_item(occurred_on=date(2026, 8, 24)),)))

        # THEN
        assert content.rows[0].occurred_on == "08/24/2026"

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
        content = build_content(person)

        # THEN
        assert content.rows[0].amount == "ARS 400.00"

    def test_null_detail_renders_empty(self):
        """
        GIVEN an outstanding item with no detail
        WHEN the content is assembled
        THEN its row detail is the empty string (never the literal 'None')
        """
        # WHEN
        content = build_content(_person(items=(_item(detail=None),)))

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
        content = build_content(person)

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
        content = build_content(person)

        # THEN
        assert content.outstanding_amount == "ARS 650.00"
        assert len(content.rows) == 1

    def test_empty_person_has_no_rows(self):
        """
        GIVEN a person with no items
        WHEN the content is assembled
        THEN there are no rows and the total still renders
        """
        content = build_content(_person(outstanding="0.00", items=()))
        assert content.rows == ()
        assert content.outstanding_amount == "ARS 0.00"


class TestBuildLayout:
    """Pagination and positioning of the content into pages (pure, ADR-209)."""

    def _texts(self, page) -> list[str]:
        return [span.text for span in page.spans]

    def test_single_page_carries_header_block_and_rows(self):
        """
        GIVEN a person with a couple of outstanding items
        WHEN the layout is built
        THEN a single page holds the title, debtor line, total and the rows
        """
        # GIVEN
        person = _person(
            name="Ana Perez",
            outstanding="1500.00",
            items=(_item(remaining="1000.00"), _item(remaining="500.00")),
        )

        # WHEN
        pages = build_layout(person)

        # THEN
        assert len(pages) == 1
        texts = self._texts(pages[0])
        assert "Outstanding Balance Statement" in texts
        assert "Debtor: Ana Perez" in texts
        assert "Total outstanding: ARS 1,500.00" in texts
        assert "Date" in texts  # column headers present

    def test_paginates_long_item_lists_repeating_headers(self):
        """
        GIVEN a person with many outstanding items (more than fit on one page)
        WHEN the layout is built
        THEN the rows spill onto a second page and the column headers repeat there
        """
        # GIVEN — 40 items overflow the single-page row budget.
        items = tuple(_item(remaining=f"{i + 1}.00", detail=f"item {i}") for i in range(40))
        person = _person(outstanding="820.00", items=items)

        # WHEN
        pages = build_layout(person)

        # THEN — two pages, each carrying its own 'Date' column header row.
        assert len(pages) == 2
        assert "Date" in self._texts(pages[0])
        assert "Date" in self._texts(pages[1])
        # AND — the title only appears on the first page.
        assert "Outstanding Balance Statement" in self._texts(pages[0])
        assert "Outstanding Balance Statement" not in self._texts(pages[1])


class TestPdfFilename:
    """The attachment filename slug (ADR-209)."""

    def test_slugifies_spaces_and_punctuation(self):
        """
        GIVEN a debtor name with spaces and punctuation
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
