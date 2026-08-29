"""Per-person receivable PDF builder (ADR-209).

Builds a shareable, hand-to-the-person PDF for one person: their name, the total they
still owe, and the itemized outstanding entries (date / amount / detail) that justify
that total. The document is rendered server-side with PyMuPDF (``fitz``), reusing the
existing native dependency (ADR-069/076); the download route wraps the returned bytes in
an attachment response exactly like the CSV exports (ADR-165).

The document **follows the app language** (ADR-209, amended): Spanish (es-AR) or English
(en-US) labels AND locale-appropriate number/date formatting (es-AR ``1.234,56`` +
``DD/MM/YYYY``; en-US ``1,234.56`` + ``MM/DD/YYYY``), with amounts always denominated in
ARS. The active locale arrives from the frontend as the ``lang`` query param and is
normalized to :data:`_DEFAULT_LOCALE` (``es``) when unknown. The copy is deliberately
**plain and informal** (a short friendly intro line), and contains **no em-dashes or
en-dashes** anywhere in the rendered output (commas, colons and parentheses only). Simple
**vector icons** (drawn with PyMuPDF shape primitives, so they can never render as tofu)
sit beside the name, the total, and each column header so an informal recipient reads it
easily.

**v1 shows outstanding items only** (ADR-209): fully-settled / overpaid items (item
``remaining`` <= 0) are excluded, settled/paid history is a deferred extension. The
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
from enum import Enum
from typing import Literal

from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableItemReadModel,
)

# The locales the shareable document supports: the app's Spanish (es-AR) default and the
# English (en-US) alternative. The frontend passes the active i18n locale as ``lang``.
Locale = Literal["es", "en"]

# When the ``lang`` query param is missing or unrecognized we fall back to Spanish, the
# app's default UI language and domain locale (ADR-102).
_DEFAULT_LOCALE: Locale = "es"

# The ARS currency prefix shown before every amount (both locales stay ARS, ADR-209).
_CURRENCY_PREFIX = "ARS"

# Placeholder used while swapping ``,`` and ``.`` to reformat en-US grouping into es-AR
# grouping without a collision (dot thousands + comma decimal).
_GROUP_SWAP_SENTINEL = "\x00"


@dataclass(frozen=True, slots=True)
class _LocaleStrings:
    """The localized copy + formatting rules for one document locale (ADR-209).

    Attributes:
        title_template: Friendly document title, ``{name}`` interpolated with the person.
        intro_template: Warm, informal one-line intro, ``{name}`` interpolated.
        total_label: The label preceding the authoritative outstanding total.
        column_headers: The ``(date, amount, detail)`` table column labels.
        date_format: ``strftime`` pattern for row dates (locale month/day order).
        es_grouping: Whether to reformat amounts into es-AR ``1.234,56`` grouping.
    """

    title_template: str
    intro_template: str
    total_label: str
    column_headers: tuple[str, str, str]
    date_format: str
    es_grouping: bool


# Localized copy for both languages. Deliberately plain and informal, and free of em/en
# dashes so nothing renders a stray glyph on a document handed to another person (ADR-209).
_STRINGS: dict[Locale, _LocaleStrings] = {
    "es": _LocaleStrings(
        title_template="Cuenta de {name}",
        intro_template="Hola {name}, este es un resumen de lo que quedó pendiente.",
        total_label="Total adeudado:",
        column_headers=("Fecha", "Monto", "Detalle"),
        date_format="%d/%m/%Y",  # es-AR day/month/year.
        es_grouping=True,  # 1.234,56 (dot thousands, comma decimal).
    ),
    "en": _LocaleStrings(
        title_template="What {name} owes",
        intro_template="Hi {name}, here is a quick summary of what is still pending.",
        total_label="Total owed:",
        column_headers=("Date", "Amount", "Detail"),
        date_format="%m/%d/%Y",  # en-US month/day/year.
        es_grouping=False,  # 1,234.56 (comma thousands, dot decimal).
    ),
}

_EMPTY_DETAIL = ""

# --- Layout geometry (PDF points; A4 portrait, top-left origin, y grows down) --- #
_PAGE_WIDTH = 595.0
_PAGE_HEIGHT = 842.0
_MARGIN_TOP = 64.0
_MAX_Y = 800.0  # New page once a row would be placed below this baseline.
_TITLE_GAP = 30.0
_INTRO_GAP = 26.0
_TOTAL_GAP = 34.0
_COLUMN_HEADER_GAP = 22.0
_ROW_HEIGHT = 18.0

_COL_DATE_X = 50.0
_COL_AMOUNT_X = 170.0
_COL_DETAIL_X = 300.0

_TITLE_SIZE = 18.0
_INTRO_SIZE = 11.0
_TOTAL_SIZE = 13.0
_HEADER_SIZE = 11.0
_BODY_SIZE = 10.0

# Icon sizes (square side, PDF points) sitting beside each field, and the gap between an
# icon and the text that follows it.
_TITLE_ICON = 16.0
_TOTAL_ICON = 14.0
_HEADER_ICON = 11.0
_ICON_TEXT_GAP = 7.0

# PyMuPDF base-14 font names (no font file needed).
_FONT_NORMAL = "helv"
_FONT_BOLD = "hebo"

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_FILENAME_FALLBACK = "person"


class IconKind(Enum):
    """The simple vector icons drawn beside document fields (ADR-209).

    Each is drawn from PyMuPDF shape primitives (circles, rects, lines), so it renders
    reliably on any platform and can never appear as a missing-glyph tofu box.
    """

    PERSON = "person"  # Beside the debtor's name / title.
    MONEY = "money"  # Beside the total and the amount column.
    CALENDAR = "calendar"  # Beside the date column.
    NOTE = "note"  # Beside the detail column.


def normalize_locale(lang: str | None) -> Locale:
    """Normalize a raw ``lang`` query value to a supported :data:`Locale` (ADR-209).

    English is selected for any value that starts with ``en`` (``en``, ``en-US``, ...);
    every other value, including the Spanish tags, unknown languages, empty and ``None``,
    falls back to the Spanish default (ADR-102). The comparison is case-insensitive and
    trims surrounding whitespace.

    Args:
        lang: The raw ``lang`` query-string value, or ``None`` when omitted.

    Returns:
        ``"en"`` for an English tag, otherwise the ``"es"`` default.
    """
    value = (lang or "").strip().casefold()
    if value.startswith("en"):
        return "en"
    return _DEFAULT_LOCALE


@dataclass(frozen=True, slots=True)
class ReceivablePdfRow:
    """One rendered outstanding entry: pre-formatted, locale-aware strings (ADR-209).

    Attributes:
        occurred_on: The debt date formatted for the locale (``DD/MM/YYYY`` / ``MM/DD/YYYY``).
        amount: The still-owed amount as ``ARS 1.234,56`` / ``ARS 1,234.56`` for the locale.
        detail: The free-text justification, or an empty string when absent.
    """

    occurred_on: str
    amount: str
    detail: str


@dataclass(frozen=True, slots=True)
class ReceivablePdfContent:
    """The pure, render-agnostic content of a person's receivable PDF (ADR-209).

    Everything is already a localized string so the renderer only has to place text.

    Attributes:
        title: The friendly document title (with the person's name interpolated).
        intro: The warm, informal one-line intro (with the person's name interpolated).
        total_label: The label preceding the total (e.g. ``Total adeudado:``).
        total_amount: The authoritative person-level total, locale-formatted with ``ARS``.
        column_headers: The ``(date, amount, detail)`` table column labels.
        rows: One row per OUTSTANDING item (remaining > 0), newest-first as supplied.
    """

    title: str
    intro: str
    total_label: str
    total_amount: str
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
class IconSpan:
    """A single positioned vector icon for the renderer to draw (ADR-209).

    Attributes:
        kind: Which icon to draw.
        x: Left x-coordinate of the icon's bounding square (PDF points).
        top: Top y-coordinate of the icon's bounding square (PDF points; grows downward).
        size: The bounding square's side length in points.
    """

    kind: IconKind
    x: float
    top: float
    size: float


@dataclass(frozen=True, slots=True)
class PdfPage:
    """One laid-out page: the ordered text spans and icons to draw on it."""

    spans: tuple[TextSpan, ...]
    icons: tuple[IconSpan, ...]


def _format_amount(amount: Decimal, strings: _LocaleStrings) -> str:
    """Format an ARS amount for the locale with the currency prefix (ADR-209).

    The base uses ``,`` thousands and ``.`` decimals (``1,234.56``); for es-AR the two
    separators are swapped to dot thousands and comma decimals (``1.234,56``). The result
    is prefixed with ``ARS`` (amounts stay ARS in both locales).
    """
    base = f"{amount:,.2f}"
    if strings.es_grouping:
        base = base.replace(",", _GROUP_SWAP_SENTINEL).replace(".", ",").replace(_GROUP_SWAP_SENTINEL, ".")
    return f"{_CURRENCY_PREFIX} {base}"


def _format_date(value: date, strings: _LocaleStrings) -> str:
    """Format a debt date in the locale's day/month order (ADR-209)."""
    return value.strftime(strings.date_format)


def _is_outstanding(item: ReceivableItemReadModel) -> bool:
    """Report whether an item still carries a positive remainder (ADR-209 v1).

    Fully-settled (``remaining == 0``) and overpaid (``remaining < 0``) items are
    excluded, v1 shows outstanding items only; settled history is deferred.
    """
    return item.remaining > Decimal(0)


def build_content(person: PersonDetailReadModel, locale: Locale = _DEFAULT_LOCALE) -> ReceivablePdfContent:
    """Assemble the pure, localized content model for a person's receivable PDF (ADR-209).

    Filters to the person's OUTSTANDING items (remaining > 0) and pre-formats every
    displayed value as a locale-aware string. The person-level ``outstanding`` total is
    taken authoritatively from the read model (ADR-204/206), so it stays correct even when
    a confirmed overpayment credit makes it diverge from the sum of the shown rows.

    Args:
        person: The person-detail read model (name, outstanding, items with roll-ups).
        locale: The active document locale (``es`` or ``en``); defaults to Spanish.

    Returns:
        The render-agnostic content: friendly title + intro, formatted total, column
        headers and one formatted row per outstanding item (order preserved).
    """
    strings = _STRINGS[locale]
    rows = tuple(
        ReceivablePdfRow(
            occurred_on=_format_date(item.occurred_on, strings),
            amount=_format_amount(item.remaining, strings),
            detail=item.detail if item.detail is not None else _EMPTY_DETAIL,
        )
        for item in person.items
        if _is_outstanding(item)
    )
    return ReceivablePdfContent(
        title=strings.title_template.format(name=person.name),
        intro=strings.intro_template.format(name=person.name),
        total_label=strings.total_label,
        total_amount=_format_amount(person.outstanding, strings),
        column_headers=strings.column_headers,
        rows=rows,
    )


# The icon paired with each of the three table columns (date / amount / detail).
_COLUMN_ICONS = (IconKind.CALENDAR, IconKind.MONEY, IconKind.NOTE)
_COLUMN_XS = (_COL_DATE_X, _COL_AMOUNT_X, _COL_DETAIL_X)


def _append_column_headers(
    spans: list[TextSpan],
    icons: list[IconSpan],
    y: float,
    headers: tuple[str, str, str],
) -> float:
    """Append the bold, icon-led table column headers at ``y``; return the next baseline.

    Each column header gets its own small icon (calendar / coins / note) so an informal
    reader parses the table at a glance. The header text follows its icon; the row values
    below align to the icon's left edge (the column x).
    """
    for column_x, header, icon in zip(_COLUMN_XS, headers, _COLUMN_ICONS, strict=True):
        icons.append(IconSpan(kind=icon, x=column_x, top=y - _HEADER_ICON, size=_HEADER_ICON))
        spans.append(TextSpan(column_x + _HEADER_ICON + _ICON_TEXT_GAP, y, header, _HEADER_SIZE, _FONT_BOLD))
    return y + _COLUMN_HEADER_GAP


def build_layout(person: PersonDetailReadModel, locale: Locale = _DEFAULT_LOCALE) -> tuple[PdfPage, ...]:
    """Lay the content out into positioned, paginated pages (pure, ADR-209).

    The first page carries the icon-led title, the friendly intro line and the outstanding
    total; every page then repeats the icon-led table column headers and its share of the
    item rows. A new page begins whenever the next row would fall below :data:`_MAX_Y`, so
    an arbitrarily long list of items paginates cleanly. Keeping pagination here (not in
    the renderer) leaves :func:`render_pdf` branchless and makes the page-break logic
    unit-testable without ``fitz``.

    Args:
        person: The person-detail read model to render.
        locale: The active document locale (``es`` or ``en``); defaults to Spanish.

    Returns:
        One :class:`PdfPage` per output page (always at least one), in order.
    """
    content = build_content(person, locale)
    pages: list[tuple[list[TextSpan], list[IconSpan]]] = []
    spans: list[TextSpan] = []
    icons: list[IconSpan] = []

    y = _MARGIN_TOP
    icons.append(IconSpan(kind=IconKind.PERSON, x=_COL_DATE_X, top=y - _TITLE_ICON, size=_TITLE_ICON))
    spans.append(TextSpan(_COL_DATE_X + _TITLE_ICON + _ICON_TEXT_GAP, y, content.title, _TITLE_SIZE, _FONT_BOLD))
    y += _TITLE_GAP
    spans.append(TextSpan(_COL_DATE_X, y, content.intro, _INTRO_SIZE, _FONT_NORMAL))
    y += _INTRO_GAP
    icons.append(IconSpan(kind=IconKind.MONEY, x=_COL_DATE_X, top=y - _TOTAL_ICON, size=_TOTAL_ICON))
    total_text = f"{content.total_label} {content.total_amount}"
    spans.append(TextSpan(_COL_DATE_X + _TOTAL_ICON + _ICON_TEXT_GAP, y, total_text, _TOTAL_SIZE, _FONT_BOLD))
    y += _TOTAL_GAP
    y = _append_column_headers(spans, icons, y, content.column_headers)

    for row in content.rows:
        if y > _MAX_Y:
            pages.append((spans, icons))
            spans, icons = [], []
            y = _append_column_headers(spans, icons, _MARGIN_TOP, content.column_headers)
        spans.append(TextSpan(_COL_DATE_X, y, row.occurred_on, _BODY_SIZE, _FONT_NORMAL))
        spans.append(TextSpan(_COL_AMOUNT_X, y, row.amount, _BODY_SIZE, _FONT_NORMAL))
        spans.append(TextSpan(_COL_DETAIL_X, y, row.detail, _BODY_SIZE, _FONT_NORMAL))
        y += _ROW_HEIGHT

    pages.append((spans, icons))
    return tuple(PdfPage(spans=tuple(page_spans), icons=tuple(page_icons)) for page_spans, page_icons in pages)


# --- Icon colors (RGB 0..1) --------------------------------------------------- #
_ICON_STROKE = (0.20, 0.28, 0.42)  # Slate blue outline shared by the line icons.
_PAPER_FILL = (0.97, 0.97, 0.95)  # Off-white paper for the calendar/note bodies.
_COIN_FILL = (0.93, 0.74, 0.28)  # Warm gold for the coin faces.
_COIN_STROKE = (0.66, 0.48, 0.12)
_CAL_HEADER_FILL = (0.82, 0.30, 0.28)  # Red calendar header band.


def _draw_person(page: object, fitz: object, x: float, top: float, size: float, width: float) -> None:
    """Draw a simple head-and-shoulders person icon inside the bounding square."""
    head_center = fitz.Point(x + 0.5 * size, top + 0.30 * size)  # pyrefly: ignore
    page.draw_circle(head_center, 0.17 * size, color=_ICON_STROKE, fill=_ICON_STROKE, width=width)  # pyrefly: ignore
    shoulders = [
        fitz.Point(x + 0.20 * size, top + 0.95 * size),  # pyrefly: ignore
        fitz.Point(x + 0.30 * size, top + 0.60 * size),  # pyrefly: ignore
        fitz.Point(x + 0.70 * size, top + 0.60 * size),  # pyrefly: ignore
        fitz.Point(x + 0.80 * size, top + 0.95 * size),  # pyrefly: ignore
    ]
    page.draw_polyline(shoulders, color=_ICON_STROKE, fill=_ICON_STROKE, width=width, closePath=True)  # pyrefly: ignore


def _draw_money(page: object, fitz: object, x: float, top: float, size: float, width: float) -> None:
    """Draw two overlapping gold coins inside the bounding square."""
    back = fitz.Point(x + 0.38 * size, top + 0.42 * size)  # pyrefly: ignore
    front = fitz.Point(x + 0.60 * size, top + 0.60 * size)  # pyrefly: ignore
    page.draw_circle(back, 0.30 * size, color=_COIN_STROKE, fill=_COIN_FILL, width=width)  # pyrefly: ignore
    page.draw_circle(front, 0.30 * size, color=_COIN_STROKE, fill=_COIN_FILL, width=width)  # pyrefly: ignore


def _draw_calendar(page: object, fitz: object, x: float, top: float, size: float, width: float) -> None:
    """Draw a small calendar (body, red header band, two rings) in the bounding square."""
    body = fitz.Rect(x + 0.14 * size, top + 0.22 * size, x + 0.86 * size, top + 0.92 * size)  # pyrefly: ignore
    header = fitz.Rect(x + 0.14 * size, top + 0.22 * size, x + 0.86 * size, top + 0.40 * size)  # pyrefly: ignore
    page.draw_rect(body, color=_ICON_STROKE, fill=_PAPER_FILL, width=width)  # pyrefly: ignore
    page.draw_rect(header, color=_ICON_STROKE, fill=_CAL_HEADER_FILL, width=width)  # pyrefly: ignore
    for ring_x in (0.34, 0.66):
        page.draw_line(  # pyrefly: ignore
            fitz.Point(x + ring_x * size, top + 0.10 * size),  # pyrefly: ignore
            fitz.Point(x + ring_x * size, top + 0.28 * size),  # pyrefly: ignore
            color=_ICON_STROKE,
            width=width,
        )


def _draw_note(page: object, fitz: object, x: float, top: float, size: float, width: float) -> None:
    """Draw a small note/paper with three text lines inside the bounding square."""
    paper = fitz.Rect(x + 0.20 * size, top + 0.12 * size, x + 0.80 * size, top + 0.90 * size)  # pyrefly: ignore
    page.draw_rect(paper, color=_ICON_STROKE, fill=_PAPER_FILL, width=width)  # pyrefly: ignore
    for line_y in (0.36, 0.51, 0.66):
        page.draw_line(  # pyrefly: ignore
            fitz.Point(x + 0.32 * size, top + line_y * size),  # pyrefly: ignore
            fitz.Point(x + 0.68 * size, top + line_y * size),  # pyrefly: ignore
            color=_ICON_STROKE,
            width=width,
        )


# Dispatch each icon kind to its primitive drawing (branchless, so no unreachable arm).
_ICON_DRAWERS = {
    IconKind.PERSON: _draw_person,
    IconKind.MONEY: _draw_money,
    IconKind.CALENDAR: _draw_calendar,
    IconKind.NOTE: _draw_note,
}


def _draw_icon(page: object, fitz: object, icon: IconSpan) -> None:
    """Draw one vector icon onto a page (ADR-209, native ``fitz`` boundary).

    Dispatches on :class:`IconKind` to the matching primitive drawing. The stroke width
    scales with the icon size so small header icons stay crisp.
    """
    width = max(0.6, icon.size * 0.06)
    _ICON_DRAWERS[icon.kind](page, fitz, icon.x, icon.top, icon.size, width)


def render_pdf(pages: Sequence[PdfPage]) -> bytes:
    """Draw laid-out pages into a PDF and return its bytes (ADR-209).

    Native boundary: uses PyMuPDF (``fitz``), imported lazily so the pure builders and the
    fast test tier stay free of the native stack (mirrors the parser boundary, ADR-076).
    The input is fully positioned by :func:`build_layout`, so this only opens a document,
    adds a page per layout, draws each vector icon and places each text span, no formatting
    decisions.

    Args:
        pages: The positioned pages to draw (at least one).

    Returns:
        The rendered PDF document as bytes.
    """
    import fitz  # PyMuPDF; native PDF generation (lazy import, ADR-076/209).

    document = fitz.open()
    try:
        for page_layout in pages:
            page = document.new_page(width=_PAGE_WIDTH, height=_PAGE_HEIGHT)
            for icon in page_layout.icons:
                _draw_icon(page, fitz, icon)
            for span in page_layout.spans:
                page.insert_text((span.x, span.y), span.text, fontsize=span.size, fontname=span.font)
        return document.tobytes()
    finally:
        document.close()


def build_person_pdf(person: PersonDetailReadModel, locale: Locale = _DEFAULT_LOCALE) -> bytes:
    """Build the downloadable receivable PDF bytes for a person (ADR-209).

    Composition of the pure layout and the ``fitz`` renderer, the single entry point the
    download route calls.

    Args:
        person: The person-detail read model to render.
        locale: The active document locale (``es`` or ``en``); defaults to Spanish.

    Returns:
        The rendered PDF document as bytes.
    """
    return render_pdf(build_layout(person, locale))


def pdf_filename(person_name: str) -> str:
    """Build a safe attachment filename for a person's receivable PDF (ADR-209).

    Slugifies the person's name, collapsing any run of characters outside
    ``[A-Za-z0-9._-]`` to a single ``_`` and trimming stray separators, so the value is
    safe inside a ``Content-Disposition`` header and on disk. A name that slugifies to
    nothing (e.g. only punctuation or non-Latin script) falls back to ``person``.

    Args:
        person_name: The person's display name.

    Returns:
        A filename of the form ``receivable-<slug>.pdf``.
    """
    slug = _FILENAME_UNSAFE.sub("_", person_name).strip("_")
    return f"receivable-{slug or _FILENAME_FALLBACK}.pdf"
