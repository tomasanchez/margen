"""Per-person receivable PDF builder (ADR-209).

Builds a shareable, hand-to-the-debtor PDF for one person: their name, the total
they still owe, and the itemized outstanding entries (date / amount / detail) that
justify that total. The document is rendered server-side with PyMuPDF (``fitz``),
reusing the existing native dependency (ADR-069/076); the download route wraps the
returned bytes in an attachment response exactly like the CSV exports (ADR-165).

The document is deliberately **English (en-US)** — English labels AND en-US number
formatting (e.g. ``1,234.56``) — with amounts still denominated in ARS. This is a
scoped override of the app's default es-AR domain-constant formatting (ADR-102) for
this one shareable document, per the owner's explicit choice (ADR-209); it does not
change ADR-102 for any in-app surface, so the helpers here are private to this module.

**v1 shows outstanding items only** (ADR-209): fully-settled / overpaid items (item
``remaining`` <= 0) are excluded — settled/paid history is a deferred extension. The
person-level ``outstanding`` total is taken authoritatively from the read model
(ADR-204/206), even when it differs from the sum of the displayed rows (e.g. after a
confirmed overpayment credit).

The pure content assembly (:func:`build_content`), the layout/pagination
(:func:`build_layout`) and the filename slug (:func:`pdf_filename`) are I/O-free and
unit-testable from plain read models; only :func:`render_pdf` touches ``fitz`` (lazy
import, mirroring the parser boundary) and is exercised end-to-end through the route.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableItemReadModel,
)

# --- English (en-US) document strings and formatting (ADR-209) --------------- #
# Private to this module: this is the deliberate, scoped override of ADR-102's
# es-AR formatting for the one shareable document. Do NOT reuse these elsewhere.
_TITLE = "Outstanding Balance Statement"
_DEBTOR_PREFIX = "Debtor:"
_OUTSTANDING_LABEL = "Total outstanding:"
_CURRENCY_PREFIX = "ARS"
_COLUMN_HEADERS = ("Date", "Amount", "Detail")
_DATE_FORMAT = "%m/%d/%Y"  # en-US month/day/year.
_EMPTY_DETAIL = ""

# --- Layout geometry (PDF points; A4 portrait, top-left origin, y grows down) --- #
_PAGE_WIDTH = 595.0
_PAGE_HEIGHT = 842.0
_MARGIN_TOP = 60.0
_MAX_Y = 800.0  # New page once a row would be placed below this baseline.
_TITLE_GAP = 30.0
_DEBTOR_GAP = 24.0
_TOTAL_GAP = 30.0
_COLUMN_HEADER_GAP = 20.0
_ROW_HEIGHT = 18.0

_COL_DATE_X = 50.0
_COL_AMOUNT_X = 160.0
_COL_DETAIL_X = 300.0

_TITLE_SIZE = 18.0
_DEBTOR_SIZE = 12.0
_TOTAL_SIZE = 13.0
_HEADER_SIZE = 11.0
_BODY_SIZE = 10.0

# PyMuPDF base-14 font names (no font file needed).
_FONT_NORMAL = "helv"
_FONT_BOLD = "hebo"

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_FILENAME_FALLBACK = "person"


@dataclass(frozen=True, slots=True)
class ReceivablePdfRow:
    """One rendered outstanding entry: pre-formatted en-US strings (ADR-209).

    Attributes:
        occurred_on: The debt date formatted ``MM/DD/YYYY`` (en-US).
        amount: The still-owed amount as ``ARS 1,234.56`` (en-US grouping, ARS prefix).
        detail: The free-text justification, or an empty string when absent.
    """

    occurred_on: str
    amount: str
    detail: str


@dataclass(frozen=True, slots=True)
class ReceivablePdfContent:
    """The pure, render-agnostic content of a person's receivable PDF (ADR-209).

    Everything is already an en-US string so the renderer only has to place text.

    Attributes:
        title: The document title.
        person_name: The debtor's display name.
        outstanding_label: The label preceding the total (e.g. ``Total outstanding:``).
        outstanding_amount: The authoritative person-level total as ``ARS 1,234.56``.
        column_headers: The ``(Date, Amount, Detail)`` table column labels.
        rows: One row per OUTSTANDING item (remaining > 0), newest-first as supplied.
    """

    title: str
    person_name: str
    outstanding_label: str
    outstanding_amount: str
    column_headers: tuple[str, str, str]
    rows: tuple[ReceivablePdfRow, ...]


@dataclass(frozen=True, slots=True)
class TextSpan:
    """A single positioned run of text for the renderer to draw (branchless).

    Attributes:
        x: Left baseline x-coordinate (PDF points).
        y: Baseline y-coordinate (PDF points; grows downward).
        text: The literal string to draw.
        size: Font size in points.
        font: The PyMuPDF base-14 font name (``helv`` / ``hebo``).
    """

    x: float
    y: float
    text: str
    size: float
    font: str


@dataclass(frozen=True, slots=True)
class PdfPage:
    """One laid-out page: the ordered text spans to draw on it."""

    spans: tuple[TextSpan, ...]


def _format_amount(amount: Decimal) -> str:
    """Format an ARS amount in en-US style with the currency prefix (ADR-209).

    Uses ``,`` for thousands and ``.`` for the decimal point with two places
    (e.g. ``ARS 1,234.56``) — the deliberate en-US override of ADR-102's es-AR
    grouping, scoped to this document only.
    """
    return f"{_CURRENCY_PREFIX} {amount:,.2f}"


def _format_date(value: date) -> str:
    """Format a debt date as en-US ``MM/DD/YYYY`` (ADR-209)."""
    return value.strftime(_DATE_FORMAT)


def _is_outstanding(item: ReceivableItemReadModel) -> bool:
    """Report whether an item still carries a positive remainder (ADR-209 v1).

    Fully-settled (``remaining == 0``) and overpaid (``remaining < 0``) items are
    excluded — v1 shows outstanding items only; settled history is deferred.
    """
    return item.remaining > Decimal(0)


def build_content(person: PersonDetailReadModel) -> ReceivablePdfContent:
    """Assemble the pure en-US content model for a person's receivable PDF (ADR-209).

    Filters to the person's OUTSTANDING items (remaining > 0) and pre-formats every
    displayed value as an en-US string. The person-level ``outstanding`` total is taken
    authoritatively from the read model (ADR-204/206), so it stays correct even when a
    confirmed overpayment credit makes it diverge from the sum of the shown rows.

    Args:
        person: The person-detail read model (name, outstanding, items with roll-ups).

    Returns:
        The render-agnostic content: title, debtor name, formatted total, column
        headers and one formatted row per outstanding item (order preserved).
    """
    rows = tuple(
        ReceivablePdfRow(
            occurred_on=_format_date(item.occurred_on),
            amount=_format_amount(item.remaining),
            detail=item.detail if item.detail is not None else _EMPTY_DETAIL,
        )
        for item in person.items
        if _is_outstanding(item)
    )
    return ReceivablePdfContent(
        title=_TITLE,
        person_name=person.name,
        outstanding_label=_OUTSTANDING_LABEL,
        outstanding_amount=_format_amount(person.outstanding),
        column_headers=_COLUMN_HEADERS,
        rows=rows,
    )


def _append_column_headers(spans: list[TextSpan], y: float, headers: tuple[str, str, str]) -> float:
    """Append the bold table column headers at ``y`` and return the next baseline."""
    date_header, amount_header, detail_header = headers
    spans.append(TextSpan(_COL_DATE_X, y, date_header, _HEADER_SIZE, _FONT_BOLD))
    spans.append(TextSpan(_COL_AMOUNT_X, y, amount_header, _HEADER_SIZE, _FONT_BOLD))
    spans.append(TextSpan(_COL_DETAIL_X, y, detail_header, _HEADER_SIZE, _FONT_BOLD))
    return y + _COLUMN_HEADER_GAP


def build_layout(person: PersonDetailReadModel) -> tuple[PdfPage, ...]:
    """Lay the content out into positioned, paginated pages (pure, ADR-209).

    The first page carries the title, debtor name and outstanding total; every page
    then repeats the table column headers and its share of the item rows. A new page
    begins whenever the next row would fall below :data:`_MAX_Y`, so an arbitrarily
    long list of items paginates cleanly. Keeping pagination here (not in the renderer)
    leaves :func:`render_pdf` branchless and makes the page-break logic unit-testable
    without ``fitz``.

    Args:
        person: The person-detail read model to render.

    Returns:
        One :class:`PdfPage` per output page (always at least one), in order.
    """
    content = build_content(person)
    pages: list[list[TextSpan]] = []
    current: list[TextSpan] = []

    y = _MARGIN_TOP
    current.append(TextSpan(_COL_DATE_X, y, content.title, _TITLE_SIZE, _FONT_BOLD))
    y += _TITLE_GAP
    current.append(TextSpan(_COL_DATE_X, y, f"{_DEBTOR_PREFIX} {content.person_name}", _DEBTOR_SIZE, _FONT_NORMAL))
    y += _DEBTOR_GAP
    total_text = f"{content.outstanding_label} {content.outstanding_amount}"
    current.append(TextSpan(_COL_DATE_X, y, total_text, _TOTAL_SIZE, _FONT_BOLD))
    y += _TOTAL_GAP
    y = _append_column_headers(current, y, content.column_headers)

    for row in content.rows:
        if y > _MAX_Y:
            pages.append(current)
            current = []
            y = _append_column_headers(current, _MARGIN_TOP, content.column_headers)
        current.append(TextSpan(_COL_DATE_X, y, row.occurred_on, _BODY_SIZE, _FONT_NORMAL))
        current.append(TextSpan(_COL_AMOUNT_X, y, row.amount, _BODY_SIZE, _FONT_NORMAL))
        current.append(TextSpan(_COL_DETAIL_X, y, row.detail, _BODY_SIZE, _FONT_NORMAL))
        y += _ROW_HEIGHT

    pages.append(current)
    return tuple(PdfPage(spans=tuple(page_spans)) for page_spans in pages)


def render_pdf(pages: Sequence[PdfPage]) -> bytes:
    """Draw laid-out pages into a PDF and return its bytes (ADR-209).

    Native boundary: uses PyMuPDF (``fitz``), imported lazily so the pure builders and
    the fast test tier stay free of the native stack (mirrors the parser boundary,
    ADR-076). The input is fully positioned by :func:`build_layout`, so this only opens
    a document, adds a page per layout and places each span — no formatting decisions.

    Args:
        pages: The positioned pages to draw (at least one).

    Returns:
        The rendered PDF document as bytes.
    """
    import fitz  # PyMuPDF; native PDF generation (lazy import — ADR-076/209).

    document = fitz.open()
    try:
        for page_layout in pages:
            page = document.new_page(width=_PAGE_WIDTH, height=_PAGE_HEIGHT)
            for span in page_layout.spans:
                page.insert_text((span.x, span.y), span.text, fontsize=span.size, fontname=span.font)
        return document.tobytes()
    finally:
        document.close()


def build_person_pdf(person: PersonDetailReadModel) -> bytes:
    """Build the downloadable receivable PDF bytes for a person (ADR-209).

    Composition of the pure layout and the ``fitz`` renderer — the single entry point
    the download route calls.

    Args:
        person: The person-detail read model to render.

    Returns:
        The rendered PDF document as bytes.
    """
    return render_pdf(build_layout(person))


def pdf_filename(person_name: str) -> str:
    """Build a safe attachment filename for a person's receivable PDF (ADR-209).

    Slugifies the debtor name — collapsing any run of characters outside
    ``[A-Za-z0-9._-]`` to a single ``_`` and trimming stray separators — so the value
    is safe inside a ``Content-Disposition`` header and on disk. A name that slugifies
    to nothing (e.g. only punctuation or non-Latin script) falls back to ``person``.

    Args:
        person_name: The debtor's display name.

    Returns:
        A filename of the form ``receivable-<slug>.pdf``.
    """
    slug = _FILENAME_UNSAFE.sub("_", person_name).strip("_")
    return f"receivable-{slug or _FILENAME_FALLBACK}.pdf"
