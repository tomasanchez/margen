"""Per-person receivable statement builder — HTML/CSS via Jinja2, PDF via WeasyPrint (ADR-211).

Renders the shareable, hand-to-the-person "Estado de cuenta entre amigos" statement for one
person from an HTML/CSS design (a Jinja2 template) rasterized to PDF with WeasyPrint (ADR-211),
replacing the earlier hand-drawn PyMuPDF document (ADR-209). PyMuPDF (``fitz``) stays ONLY for
statement PARSING; it no longer draws this document.

The pipeline is three explicit layers so the design work is fully unit-testable without the
native rendering stack:

1. :func:`build_statement_view` — a **pure** function turning a
   :class:`~margen_api.service_layer.receivable_read_models.PersonDetailReadModel` (plus the
   owner name, locale and the emission date) into a :class:`StatementView` of pre-formatted,
   locale-aware strings and rows. No I/O, no framework, no fonts — 100% unit-testable.
2. :func:`render_statement_html` — renders the :class:`StatementView` through the Jinja2
   template into an HTML string. Pure string templating (fonts are resolved later, at PDF
   time, via a ``base_url``), so the whole design surface — every label, number, the
   running-balance ledger, the covered box, the footer — is asserted directly on the HTML.
3. :func:`_html_to_pdf` — the single thin adapter that calls WeasyPrint (native Pango/Cairo/
   HarfBuzz). It is the one line that cannot run on a bare Windows dev box (no GTK), so it is
   marked ``# pragma: no cover`` and exercised only where the libs exist (Linux CI / Docker /
   Render). Everything that carries business meaning lives in layers 1 and 2, fully covered.

**The document follows the app language** (ADR-209/211): Spanish (es-AR) or English (en-US),
with locale-appropriate number/date formatting (es-AR ``1.234,56`` + ``DD/MM/YYYY``; en-US
``1,234.56`` + ``MM/DD/YYYY``), amounts always ARS. The active locale arrives as the ``lang``
query param, normalized to :data:`_DEFAULT_LOCALE` (``es``) when unknown.

**No em-dashes or en-dashes anywhere** (ADR-209/211): separators are ``·`` or commas. The only
dash-like glyph permitted in the output is the real Unicode minus ``−`` (U+2212), used solely
for a payment row's negative amount. A guard test asserts this on the rendered HTML.

Sections (matching the supplied design): header eyebrow + emission date + rule; "Cuenta de"
+ debtor name + tagline; the red hero with the authoritative outstanding; a 3-stat bar
(total consumed / paid so far / outstanding); "El detalle" running-balance ledger (charges as
``+`` rows, payments as ``−`` rows, a running Saldo column, a final "Saldo a la fecha" =
authoritative outstanding); an optional "Lo pagué yo, no te lo cobro" covered box for pardoned
items; and a page footer with the owner and a real ``page X de Y`` counter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from functools import lru_cache
from importlib.resources import files
from typing import Literal

from jinja2 import Environment, PackageLoader

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

# The ARS currency code shown as the hero's side tag (amounts stay ARS in both locales).
_CURRENCY = "ARS"

# The real Unicode minus (U+2212) prefixing a payment row's negative amount — the ONLY
# dash-like glyph allowed in the output (ADR-209/211). Never a hyphen-minus or en/em dash.
_MINUS = "−"

# Placeholder used while swapping ``,`` and ``.`` to reformat en-US grouping into es-AR
# grouping without a collision (dot thousands + comma decimal).
_GROUP_SWAP_SENTINEL = "\x00"

_EMPTY_DETAIL = ""

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_FILENAME_FALLBACK = "person"


@dataclass(frozen=True, slots=True)
class _LocaleStrings:
    """The localized copy + formatting rules for one document locale (ADR-211).

    Every string is the natural-case copy that appears verbatim in the rendered HTML;
    the template applies ``text-transform: uppercase`` to the eyebrow/label styling, so
    the copy stays readable and directly assertable in tests.

    Attributes:
        eyebrow: The top-left document eyebrow ("Estado de cuenta entre amigos").
        account_of: The "Cuenta de" label above the debtor's name.
        tagline: The reassurance line under the name ("Sin intereses. Sin recargos.").
        hero_label: The hero's label above the outstanding total ("Saldo pendiente").
        stat_total_label: The "total consumed" stat label.
        stat_paid_label: The "paid so far" stat label.
        stat_pending_label: The "outstanding" stat label.
        details_title: The ledger section heading ("El detalle").
        col_date: The ledger Date column header.
        col_detail: The ledger Detail column header.
        col_amount: The ledger Amount column header.
        col_balance: The ledger Balance (running Saldo) column header.
        payment_received: The label shown as a payment row's detail ("Pago recibido").
        balance_to_date: The ledger's closing "Saldo a la fecha" label.
        covered_title: The covered box heading ("Lo pagué yo, no te lo cobro").
        covered_note: The fixed warm note under the covered rows.
        footer_issued_by: The footer prefix carrying ``{owner}`` ("Emitido por {owner}").
        footer_issued_no_owner: The footer prefix when the owner is unknown ("Emitido").
        footer_complaints: The footer's second clause ("Reclamos en persona, durante una cena").
        footer_page: The footer's page-counter template ("Página {page} de {pages}"),
            with ``{page}``/``{pages}`` substituted for live CSS counters at PDF time.
        date_format: ``strftime`` pattern for dates (locale month/day order).
        es_grouping: Whether to reformat amounts into es-AR ``1.234,56`` grouping.
        decimal_sep: The locale's decimal separator (``,`` es / ``.`` en), used to split
            the hero amount's integer part from its (smaller-set) fractional part.
    """

    eyebrow: str
    account_of: str
    tagline: str
    hero_label: str
    stat_total_label: str
    stat_paid_label: str
    stat_pending_label: str
    details_title: str
    col_date: str
    col_detail: str
    col_amount: str
    col_balance: str
    payment_received: str
    balance_to_date: str
    covered_title: str
    covered_note: str
    footer_issued_by: str
    footer_issued_no_owner: str
    footer_complaints: str
    footer_page: str
    date_format: str
    es_grouping: bool
    decimal_sep: str


# Localized copy for both languages. Deliberately warm and plain, and free of em/en dashes so
# nothing renders a stray glyph on a document handed to another person (ADR-209/211).
_STRINGS: dict[Locale, _LocaleStrings] = {
    "es": _LocaleStrings(
        eyebrow="Estado de cuenta entre amigos",
        account_of="Cuenta de",
        tagline="Sin intereses. Sin recargos.",
        hero_label="Saldo pendiente",
        stat_total_label="Total consumido",
        stat_paid_label="Pagado hasta hoy",
        stat_pending_label="Pendiente",
        details_title="El detalle",
        col_date="Fecha",
        col_detail="Detalle",
        col_amount="Importe",
        col_balance="Saldo",
        payment_received="Pago recibido",
        balance_to_date="Saldo a la fecha",
        covered_title="Lo pagué yo, no te lo cobro",
        covered_note=(
            "Esta la puse yo y no te la cobro. No entra en el saldo de arriba. "
            "Queda anotada solamente para que la próxima me invites vos."
        ),
        footer_issued_by="Emitido por {owner}",
        footer_issued_no_owner="Emitido",
        footer_complaints="Reclamos en persona, durante una cena",
        footer_page="Página {page} de {pages}",
        date_format="%d/%m/%Y",  # es-AR day/month/year.
        es_grouping=True,  # 1.234,56 (dot thousands, comma decimal).
        decimal_sep=",",
    ),
    "en": _LocaleStrings(
        eyebrow="Statement between friends",
        account_of="Account of",
        tagline="No interest. No fees.",
        hero_label="Balance due",
        stat_total_label="Total spent",
        stat_paid_label="Paid so far",
        stat_pending_label="Outstanding",
        details_title="The details",
        col_date="Date",
        col_detail="Detail",
        col_amount="Amount",
        col_balance="Balance",
        payment_received="Payment received",
        balance_to_date="Balance to date",
        covered_title="I covered this, on me",
        covered_note=(
            "I covered this one and I am not charging you for it. It does not count toward the "
            "balance above. It is noted here only so next time you treat me."
        ),
        footer_issued_by="Issued by {owner}",
        footer_issued_no_owner="Issued",
        footer_complaints="Complaints in person, over dinner",
        footer_page="Page {page} of {pages}",
        date_format="%m/%d/%Y",  # en-US month/day/year.
        es_grouping=False,  # 1,234.56 (comma thousands, dot decimal).
        decimal_sep=".",
    ),
}


def normalize_locale(lang: str | None) -> Locale:
    """Normalize a raw ``lang`` query value to a supported :data:`Locale` (ADR-209/211).

    English is selected for any value that starts with ``en`` (``en``, ``en-US``, ...); every
    other value — the Spanish tags, unknown languages, empty and ``None`` — falls back to the
    Spanish default (ADR-102). The comparison is case-insensitive and trims whitespace.

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
class LedgerRow:
    """One row of the "El detalle" running-balance ledger (ADR-211).

    Attributes:
        occurred_on: The event date, locale-formatted (``DD/MM/YYYY`` / ``MM/DD/YYYY``).
        detail: The charge's free-text detail, or the localized "Pago recibido" for a payment.
        amount: The signed amount, locale-formatted; payments carry a leading ``−`` (U+2212).
        balance: The running balance after this event, locale-formatted (charge ``+``, payment
            ``−``).
        is_payment: Whether this is a payment row (styled in the warm red, right-aligned minus).
    """

    occurred_on: str
    detail: str
    amount: str
    balance: str
    is_payment: bool


@dataclass(frozen=True, slots=True)
class CoveredRow:
    """One pardoned item shown in the "Lo pagué yo" covered box (ADR-210/211).

    Attributes:
        occurred_on: The item date, locale-formatted.
        detail: The item's free-text detail, or an empty string when absent.
        amount: The covered amount (its remainder at pardon), locale-formatted.
    """

    occurred_on: str
    detail: str
    amount: str


@dataclass(frozen=True, slots=True)
class StatementView:
    """The pure, fully-localized view model the statement template consumes (ADR-211).

    Every field is a ready-to-place string (or a tuple of the row dataclasses above), so the
    template makes no formatting or business decisions and the whole surface is unit-testable
    without WeasyPrint.
    """

    lang: Locale
    # Header.
    eyebrow: str
    date_line: str
    account_of: str
    debtor_name: str
    tagline: str
    # Hero (outstanding).
    hero_label: str
    hero_amount_main: str
    hero_amount_frac: str
    currency: str
    # Stat bar.
    stat_total_label: str
    stat_total_value: str
    stat_paid_label: str
    stat_paid_value: str
    stat_pending_label: str
    stat_pending_value: str
    # Ledger.
    details_title: str
    col_date: str
    col_detail: str
    col_amount: str
    col_balance: str
    ledger_rows: tuple[LedgerRow, ...]
    balance_to_date_label: str
    balance_to_date_value: str
    # Covered box (optional).
    show_covered: bool
    covered_title: str
    covered_rows: tuple[CoveredRow, ...]
    covered_note: str
    # Footer.
    footer_issued: str
    footer_complaints: str
    footer_page_template: str


def _format_number(amount: Decimal, strings: _LocaleStrings) -> str:
    """Format an ARS magnitude for the locale WITHOUT a currency prefix (ADR-211).

    The base uses ``,`` thousands and ``.`` decimals (``1,234.56``); for es-AR the two
    separators are swapped to dot thousands and comma decimals (``1.234,56``). The design
    shows amounts bare (the hero carries a separate ``ARS`` tag), so no prefix is added.
    """
    base = f"{amount:,.2f}"
    if strings.es_grouping:
        base = base.replace(",", _GROUP_SWAP_SENTINEL).replace(".", ",").replace(_GROUP_SWAP_SENTINEL, ".")
    return base


def _split_hero_amount(amount: Decimal, strings: _LocaleStrings) -> tuple[str, str]:
    """Split a formatted amount into its integer part and its (smaller-set) fractional part.

    The hero renders the integer part large and the decimals small (matching the design), so
    the formatted string is split on the locale decimal separator: ``("34.500", ",00")`` for
    es-AR, ``("34,500", ".00")`` for en-US. A negative outstanding keeps its sign on the main
    part.
    """
    formatted = _format_number(amount, strings)
    main, _, cents = formatted.rpartition(strings.decimal_sep)
    return main, strings.decimal_sep + cents


def _format_date(value: date, strings: _LocaleStrings) -> str:
    """Format a date in the locale's day/month order (ADR-209/211)."""
    return value.strftime(strings.date_format)


def _is_covered(item: ReceivableItemReadModel) -> bool:
    """Report whether a pardoned item belongs in the covered box (ADR-210).

    A pardoned item is shown as covered when it still had something to forgive, i.e. its
    remainder at pardon (``amount`` minus its allocations) is positive.
    """
    return item.pardoned and item.remaining > Decimal(0)


@dataclass(frozen=True, slots=True)
class _LedgerEvent:
    """An internal, unformatted ledger event used to compute the running balance."""

    occurred_on: date
    detail: str
    amount: Decimal
    is_payment: bool


def _ledger_events(person: PersonDetailReadModel, strings: _LocaleStrings) -> list[_LedgerEvent]:
    """Merge non-pardoned charges and payments into date-ascending ledger events (ADR-211).

    Charges are every NON-pardoned item (importe = its ``amount``, not its remainder — the
    ledger shows what was consumed); payments are every payback. Charges precede payments on the
    same date (you run up a tab, then pay it), achieved by a stable sort over a charges-first
    list.
    """
    charges = [
        _LedgerEvent(
            occurred_on=item.occurred_on,
            detail=item.detail if item.detail is not None else _EMPTY_DETAIL,
            amount=item.amount,
            is_payment=False,
        )
        for item in person.items
        if not item.pardoned
    ]
    payments = [
        _LedgerEvent(
            occurred_on=payment.occurred_on,
            detail=strings.payment_received,
            amount=payment.amount,
            is_payment=True,
        )
        for payment in person.payments
    ]
    return sorted([*charges, *payments], key=lambda event: event.occurred_on)


def _build_ledger_rows(person: PersonDetailReadModel, strings: _LocaleStrings) -> tuple[LedgerRow, ...]:
    """Format the merged ledger events, carrying the running balance down the column (ADR-211).

    Walks the date-ascending events keeping a running balance: a charge adds its amount, a
    payment subtracts it. Payment amounts render with a leading real minus ``−`` (U+2212) and
    are flagged so the template styles them in the warm red.
    """
    rows: list[LedgerRow] = []
    running = Decimal(0)
    for event in _ledger_events(person, strings):
        if event.is_payment:
            running -= event.amount
            amount = f"{_MINUS} {_format_number(event.amount, strings)}"
        else:
            running += event.amount
            amount = _format_number(event.amount, strings)
        rows.append(
            LedgerRow(
                occurred_on=_format_date(event.occurred_on, strings),
                detail=event.detail,
                amount=amount,
                balance=_format_number(running, strings),
                is_payment=event.is_payment,
            )
        )
    return tuple(rows)


def _footer_issued(strings: _LocaleStrings, owner_name: str) -> str:
    """Resolve the footer's "Emitido por {owner}" clause, dropping the owner when unknown."""
    owner = owner_name.strip()
    if not owner:
        return strings.footer_issued_no_owner
    return strings.footer_issued_by.format(owner=owner)


def build_statement_view(
    person: PersonDetailReadModel,
    *,
    owner_name: str = "",
    lang: Locale = _DEFAULT_LOCALE,
    today: date,
) -> StatementView:
    """Assemble the pure, localized :class:`StatementView` for a person's statement (ADR-211).

    Pre-formats every displayed value as a locale-aware string:

    - The hero shows the authoritative ``person.outstanding`` (ADR-206), split into a large
      integer part and a small fractional part.
    - The 3-stat bar shows total consumed (Σ non-pardoned item amounts), paid so far (Σ
      payments), and outstanding (the authoritative total).
    - The ledger interleaves non-pardoned charges (``+``) and payments (``−``) date-ascending
      with a running balance, closing on "Saldo a la fecha" = the authoritative outstanding.
    - The covered box lists pardoned items with their covered amount; it is omitted when the
      person has none.
    - The footer carries the owner (dropped gracefully when unknown) and the complaints clause;
      the page template's ``{page}``/``{pages}`` are substituted for live CSS counters at PDF
      time.

    Args:
        person: The person-detail read model (name, outstanding, items, payments).
        owner_name: The current owner's display name for the footer; the empty string drops the
            "por {owner}" suffix gracefully.
        lang: The active document locale (``es`` or ``en``); defaults to Spanish.
        today: The emission date shown in the header (injected for deterministic rendering).

    Returns:
        The render-agnostic :class:`StatementView` the template consumes.
    """
    strings = _STRINGS[lang]
    total_consumed = sum((item.amount for item in person.items if not item.pardoned), Decimal(0))
    total_paid = sum((payment.amount for payment in person.payments), Decimal(0))
    hero_main, hero_frac = _split_hero_amount(person.outstanding, strings)
    covered_rows = tuple(
        CoveredRow(
            occurred_on=_format_date(item.occurred_on, strings),
            detail=item.detail if item.detail is not None else _EMPTY_DETAIL,
            amount=_format_number(item.remaining, strings),
        )
        for item in person.items
        if _is_covered(item)
    )
    return StatementView(
        lang=lang,
        eyebrow=strings.eyebrow,
        date_line=_format_date(today, strings),
        account_of=strings.account_of,
        debtor_name=person.name,
        tagline=strings.tagline,
        hero_label=strings.hero_label,
        hero_amount_main=hero_main,
        hero_amount_frac=hero_frac,
        currency=_CURRENCY,
        stat_total_label=strings.stat_total_label,
        stat_total_value=_format_number(total_consumed, strings),
        stat_paid_label=strings.stat_paid_label,
        stat_paid_value=_format_number(total_paid, strings),
        stat_pending_label=strings.stat_pending_label,
        stat_pending_value=_format_number(person.outstanding, strings),
        details_title=strings.details_title,
        col_date=strings.col_date,
        col_detail=strings.col_detail,
        col_amount=strings.col_amount,
        col_balance=strings.col_balance,
        ledger_rows=_build_ledger_rows(person, strings),
        balance_to_date_label=strings.balance_to_date,
        balance_to_date_value=_format_number(person.outstanding, strings),
        show_covered=bool(covered_rows),
        covered_title=strings.covered_title,
        covered_rows=covered_rows,
        covered_note=strings.covered_note,
        footer_issued=_footer_issued(strings, owner_name),
        footer_complaints=strings.footer_complaints,
        footer_page_template=strings.footer_page,
    )


@lru_cache(maxsize=1)
def _environment() -> Environment:
    """Build (once) the autoescaping Jinja2 environment loading the packaged template.

    Autoescaping is forced on (the template name ends ``.jinja``, which the extension-based
    ``select_autoescape`` would miss) so a debtor name or item detail can never inject markup
    into the rendered HTML.
    """
    return Environment(
        loader=PackageLoader("margen_api", "assets/templates"),
        autoescape=True,
    )


def render_statement_html(view: StatementView) -> str:
    """Render the :class:`StatementView` through the Jinja2 template into an HTML string (ADR-211).

    Pure string templating: the ``@font-face`` rules reference the Archivo TTFs by relative
    URL, resolved later against a ``base_url`` at PDF time, so this stays deterministic and free
    of font/native concerns. The full design surface is asserted directly on this HTML.

    Args:
        view: The pre-formatted statement view model.

    Returns:
        The complete HTML document as a string.
    """
    return _environment().get_template("statement.html.jinja").render(view=view, minus=_MINUS)


# The packaged assets directory (templates + fonts). Used as WeasyPrint's ``base_url`` so the
# template's relative ``url('fonts/Archivo-*.ttf')`` references resolve to the shipped TTFs.
_ASSETS_DIR = files("margen_api") / "assets"


def _html_to_pdf(html: str) -> bytes:  # pragma: no cover - native WeasyPrint boundary (ADR-211)
    """Rasterize a statement HTML string to PDF bytes with WeasyPrint (ADR-211).

    The single native boundary: WeasyPrint pulls in Pango/Cairo/HarfBuzz, which are absent on a
    bare Windows dev box, so this one call is ``# pragma: no cover`` and runs only where the
    libs exist (Linux CI, the Docker image, Render). Everything meaningful — the view model and
    the template-to-HTML rendering — is fully covered in layers 1 and 2. ``base_url`` points at
    the packaged assets dir so the template's relative font URLs resolve to the shipped Archivo
    TTFs.

    Args:
        html: The complete statement HTML produced by :func:`render_statement_html`.

    Returns:
        The rendered PDF document as bytes.
    """
    import weasyprint  # Native HTML-to-PDF (lazy import; GTK/Pango only present on Linux).

    pdf = weasyprint.HTML(string=html, base_url=str(_ASSETS_DIR)).write_pdf()
    if pdf is None:  # write_pdf() returns bytes when no target path is given; defensive only.
        raise RuntimeError("WeasyPrint returned no PDF bytes.")
    return pdf


def build_statement_pdf(
    person: PersonDetailReadModel,
    *,
    owner_name: str = "",
    lang: Locale = _DEFAULT_LOCALE,
    today: date,
) -> bytes:
    """Build the downloadable receivable-statement PDF bytes for a person (ADR-211).

    Composes the three layers: pure view model, template-to-HTML, then the WeasyPrint adapter.
    The single entry point the download route calls.

    Args:
        person: The person-detail read model to render.
        owner_name: The current owner's display name for the footer; empty drops it gracefully.
        lang: The active document locale (``es`` or ``en``); defaults to Spanish.
        today: The emission date shown in the header.

    Returns:
        The rendered PDF document as bytes.
    """
    view = build_statement_view(person, owner_name=owner_name, lang=lang, today=today)
    return _html_to_pdf(render_statement_html(view))


def pdf_filename(person_name: str) -> str:
    """Build a safe attachment filename for a person's receivable statement (ADR-209/211).

    Slugifies the person's name, collapsing any run of characters outside ``[A-Za-z0-9._-]`` to
    a single ``_`` and trimming stray separators, so the value is safe inside a
    ``Content-Disposition`` header and on disk. A name that slugifies to nothing falls back to
    ``person``.

    Args:
        person_name: The person's display name.

    Returns:
        A filename of the form ``receivable-<slug>.pdf``.
    """
    slug = _FILENAME_UNSAFE.sub("_", person_name).strip("_")
    return f"receivable-{slug or _FILENAME_FALLBACK}.pdf"
