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
(total consumed / paid so far / outstanding); an optional, informational "Próximas cuotas"
strip with the not-yet-due cuotas (ADR-222); "El detalle" running-balance ledger (charges as
``+`` rows, payments as ``−`` rows, a running Saldo column, a final "Saldo a la fecha" =
authoritative outstanding); an optional "Lo pagué yo, no te lo cobro" covered box for pardoned
items; and a page footer with the owner and a real ``page X de Y`` counter.

**Two content modes** (ADR-212, refining ADR-211). The export defaults to **outstanding-only**:
the "El detalle" ledger lists only the items still owed (``remaining`` > 0, not pardoned) at
their REMAINING amount, the running Saldo is the cumulative remaining closing on the
authoritative outstanding, there are NO payment rows, and a calm "al día" empty state renders
when nothing is owed. The hero, the all-time 3-stat bar and the covered box are retained.
Passing ``full_history=True`` restores the full running-balance ledger (every non-pardoned
charge at its gross amount interleaved with payment ``−`` rows) exactly as ADR-211 shipped it.
The mode is threaded from the ``?full`` query param through :func:`build_statement_pdf` and
:func:`build_statement_view`.

**Installment items render per cuota** (ADR-222, amending ADR-211/212). Outstanding counts only
the cuotas already due (ADR-215), so an installment item never appears as one lump: in the
outstanding-only ledger it contributes one "TV · Cuota 3/6" row per DUE cuota at that cuota's
remaining, dated by its due date, and its not-yet-due cuotas are summed into a separate,
informational "Próximas cuotas" strip that is NOT part of the hero balance. In the full history
every cuota is listed with its status: due and paid cuotas are charges at their full amount (the
payment rows net them), upcoming and forgiven cuotas are muted rows that stay out of the running
Saldo (if part of one was already paid, that paid part becomes its own "Pagada" charge so the
payment that covered it still nets to zero). Either way, the Saldo column closes on the due-only
hero balance. Forgiven cuotas also join the covered box at their forgiven remainder, as pardoned
items do (ADR-210, ADR-221). When the person holds a credit (a confirmed overpayment of an item
or cuota, ADR-206), the outstanding-only ledger closes with a "Saldo a favor" row for it, so its
Saldo column still lands on the hero. Cuota states come from the read model, which the reader assessed as
of the request's injected "today" (ADR-215, ADR-223), so the builder never reads the clock.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from functools import lru_cache
from importlib.resources import files
from typing import Literal

from jinja2 import Environment, PackageLoader

from margen_api.domain.models.receivable_settlement import InstallmentStatus
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    ReceivableInstallmentReadModel,
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

# Joins an item's detail and its cuota label ("TV · Cuota 3/6", ADR-222): a middle dot, never a
# dash (ADR-209/211).
_DETAIL_SEPARATOR = " · "

# The Saldo cell of a row that does not move the running balance (an upcoming or forgiven cuota).
_NO_BALANCE = ""

# The Date cell of the credit row, which sums overpayments made on different dates.
_NO_DATE = ""

# Cuota statuses listed in the full ledger for information only: they stay out of the running
# Saldo, exactly as they stay out of the due-only outstanding (ADR-215, ADR-221, ADR-222).
_OUT_OF_BALANCE = frozenset({InstallmentStatus.UPCOMING, InstallmentStatus.PARDONED})

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
        empty_state: The calm "nothing owed / al día" message shown in the ledger area when
            the outstanding-only export has no items still owed (ADR-212).
        credit_label: The outstanding-only row carrying the credit the person holds after a
            confirmed overpayment ("Saldo a favor", ADR-206).
        installment_label: A cuota's position in its plan ("Cuota {index}/{count}"), appended to
            the item detail on every cuota row (ADR-222).
        status_labels: The full-history tag for each cuota status ("Pendiente", "Pagada",
            "Próxima", "Perdonada"; ADR-222).
        upcoming_label: The heading of the informational not-yet-due strip ("Próximas cuotas").
        upcoming_note: The strip's note saying those cuotas are not part of the balance (ADR-215).
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
    empty_state: str
    credit_label: str
    installment_label: str
    status_labels: Mapping[InstallmentStatus, str]
    upcoming_label: str
    upcoming_note: str
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
        empty_state="Estás al día. No hay nada pendiente.",
        credit_label="Saldo a favor",
        installment_label="Cuota {index}/{count}",
        status_labels={
            InstallmentStatus.DUE: "Pendiente",
            InstallmentStatus.PAID: "Pagada",
            InstallmentStatus.UPCOMING: "Próxima",
            InstallmentStatus.PARDONED: "Perdonada",
        },
        upcoming_label="Próximas cuotas",
        upcoming_note="Todavía no vencen, así que no entran en el saldo pendiente.",
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
        empty_state="You are all square. Nothing outstanding.",
        credit_label="Credit in your favor",
        installment_label="Installment {index}/{count}",
        status_labels={
            InstallmentStatus.DUE: "Due",
            InstallmentStatus.PAID: "Paid",
            InstallmentStatus.UPCOMING: "Upcoming",
            InstallmentStatus.PARDONED: "Forgiven",
        },
        upcoming_label="Upcoming installments",
        upcoming_note="Not due yet, so they are not part of the balance due.",
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
    """One row of the "El detalle" running-balance ledger (ADR-211, ADR-222).

    Attributes:
        occurred_on: The event date, locale-formatted (``DD/MM/YYYY`` / ``MM/DD/YYYY``); a
            cuota row carries its due date.
        detail: The charge's free-text detail ("TV · Cuota 3/6" for a cuota), or the localized
            "Pago recibido" for a payment.
        amount: The signed amount, locale-formatted; payments carry a leading ``−`` (U+2212).
        balance: The running balance after this event, locale-formatted (charge ``+``, payment
            ``−``); empty for a row that stays out of the balance (an upcoming or forgiven cuota).
        is_payment: Whether this is a payment row (styled in the warm red, right-aligned minus).
        status: The cuota status a full-history cuota row is tagged with (ADR-222); ``None`` for
            flat items, payments and every outstanding-only row.
        status_label: The localized tag for ``status`` ("Pagada", "Próxima", ...), else empty.
    """

    occurred_on: str
    detail: str
    amount: str
    balance: str
    is_payment: bool
    status: InstallmentStatus | None = None
    status_label: str = ""

    @property
    def in_balance(self) -> bool:
        """Report whether the row moves the running Saldo; upcoming and forgiven cuotas do not."""
        return self.status not in _OUT_OF_BALANCE


@dataclass(frozen=True, slots=True)
class CoveredRow:
    """One pardoned item, or forgiven cuota, shown in the "Lo pagué yo" covered box (ADR-210/211/221).

    Attributes:
        occurred_on: The item date (a cuota's due date), locale-formatted.
        detail: The item's free-text detail ("TV · Cuota 2/6" for a cuota), or an empty string
            when absent.
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
    # Content mode: False = outstanding-only (default), True = full running-balance history (ADR-212).
    full_history: bool
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
    # Upcoming-cuotas strip (optional, informational, never part of the hero balance, ADR-222).
    show_upcoming: bool
    upcoming_label: str
    upcoming_value: str
    upcoming_note: str
    # Ledger.
    details_title: str
    col_date: str
    col_detail: str
    col_amount: str
    col_balance: str
    ledger_rows: tuple[LedgerRow, ...]
    balance_to_date_label: str
    balance_to_date_value: str
    empty_state: str
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
    """Report whether a pardoned flat item belongs in the covered box (ADR-210).

    A pardoned item is shown as covered when it still had something to forgive, i.e. its
    remainder at pardon (``amount`` minus its allocations) is positive. Installment items are
    covered cuota by cuota instead (:func:`_covered_rows`, ADR-221).
    """
    return item.pardoned and item.remaining > Decimal(0)


def _is_outstanding(item: ReceivableItemReadModel) -> bool:
    """Report whether a flat item still owes money in the outstanding-only ledger (ADR-212).

    An item is outstanding when it is NOT pardoned and still carries a positive remainder.
    Fully-paid (``remaining`` == 0), overpaid (``remaining`` < 0) and pardoned items are all
    excluded — the default export lists only what is genuinely still owed, regardless of the
    month it was incurred, so an old unpaid debt keeps appearing. Installment items are listed
    cuota by cuota instead (:func:`_owed_events`, ADR-222).
    """
    return not item.pardoned and item.remaining > Decimal(0)


def _item_detail(item: ReceivableItemReadModel) -> str:
    """Return an item's free-text detail, or the empty string when it has none."""
    return item.detail if item.detail is not None else _EMPTY_DETAIL


def _cuota_detail(
    item: ReceivableItemReadModel,
    cuota: ReceivableInstallmentReadModel,
    strings: _LocaleStrings,
) -> str:
    """Label a cuota row as the item detail plus its plan position, "TV · Cuota 3/6" (ADR-222).

    An item without a detail shows the position alone ("Cuota 3/6").
    """
    position = strings.installment_label.format(index=cuota.index, count=len(item.installments))
    if not item.detail:
        return position
    return f"{item.detail}{_DETAIL_SEPARATOR}{position}"


def _consumed(item: ReceivableItemReadModel) -> Decimal:
    """Return what an item adds to the "Total consumido" stat: its non-forgiven amount (ADR-210).

    A flat item counts its whole amount unless pardoned; an installment item counts the amounts
    of its cuotas that are not forgiven, since pardon targets cuotas there (ADR-221).
    """
    if item.installments:
        return sum((cuota.amount for cuota in item.installments if not cuota.pardoned), Decimal(0))
    return Decimal(0) if item.pardoned else item.amount


@dataclass(frozen=True, slots=True)
class _LedgerEvent:
    """An internal, unformatted ledger event used to compute the running balance.

    ``status`` tags a full-history cuota row (ADR-222); an upcoming or forgiven one is listed for
    information only and does not move the running balance.
    """

    occurred_on: date
    detail: str
    amount: Decimal
    is_payment: bool
    status: InstallmentStatus | None = None


def _cuota_events(
    item: ReceivableItemReadModel,
    cuota: ReceivableInstallmentReadModel,
    strings: _LocaleStrings,
) -> list[_LedgerEvent]:
    """Turn one cuota into its full-history ledger event(s), dated by its due date (ADR-222).

    A due or paid cuota is a charge at its full amount, netted by the payment rows exactly like a
    flat item's charge (ADR-211). An upcoming or forgiven cuota stays out of the running balance,
    as it stays out of the due-only outstanding (ADR-215, ADR-221): it is listed at what is left
    of it, tagged with its status. Whatever was already paid toward such a cuota (paid ahead, or
    paid before the pardon) is split off as its own paid charge, so the payment row that covered
    it still nets to zero and the Saldo keeps closing on the outstanding.
    """
    detail = _cuota_detail(item, cuota, strings)
    if cuota.status not in _OUT_OF_BALANCE:
        return [_LedgerEvent(cuota.due_on, detail, cuota.amount, is_payment=False, status=cuota.status)]
    paid_part = min(cuota.paid, cuota.amount)
    events: list[_LedgerEvent] = []
    if paid_part > Decimal(0):
        events.append(_LedgerEvent(cuota.due_on, detail, paid_part, is_payment=False, status=InstallmentStatus.PAID))
    if cuota.amount > paid_part:
        events.append(
            _LedgerEvent(cuota.due_on, detail, cuota.amount - paid_part, is_payment=False, status=cuota.status)
        )
    return events


def _ledger_events(person: PersonDetailReadModel, strings: _LocaleStrings) -> list[_LedgerEvent]:
    """Merge the charges and payments into date-ascending full-history events (ADR-211, ADR-222).

    Charges are every NON-pardoned flat item (importe = its ``amount``, not its remainder — the
    ledger shows what was consumed) and every cuota of an installment item
    (:func:`_cuota_events`); payments are every payback. Charges precede payments on the same
    date (you run up a tab, then pay it), achieved by a stable sort over a charges-first list.
    """
    charges: list[_LedgerEvent] = []
    for item in person.items:
        if item.installments:
            for cuota in item.installments:
                charges.extend(_cuota_events(item, cuota, strings))
        elif not item.pardoned:
            charges.append(_LedgerEvent(item.occurred_on, _item_detail(item), item.amount, is_payment=False))
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
    payment subtracts it, and an upcoming or forgiven cuota leaves it untouched with an empty
    Saldo cell (ADR-222). Payment amounts render with a leading real minus ``−`` (U+2212) and
    are flagged so the template styles them in the warm red.
    """
    rows: list[LedgerRow] = []
    running = Decimal(0)
    for event in _ledger_events(person, strings):
        amount = _format_number(event.amount, strings)
        balance = _NO_BALANCE
        if event.is_payment:
            running -= event.amount
            amount = f"{_MINUS} {amount}"
            balance = _format_number(running, strings)
        elif event.status not in _OUT_OF_BALANCE:
            running += event.amount
            balance = _format_number(running, strings)
        rows.append(
            LedgerRow(
                occurred_on=_format_date(event.occurred_on, strings),
                detail=event.detail,
                amount=amount,
                balance=balance,
                is_payment=event.is_payment,
                status=event.status,
                status_label=strings.status_labels[event.status] if event.status is not None else "",
            )
        )
    return tuple(rows)


def _owed_events(person: PersonDetailReadModel, strings: _LocaleStrings) -> list[_LedgerEvent]:
    """Collect what is owed now, at its remaining amount, date-ascending (ADR-212, ADR-222).

    A flat item that is still owed (:func:`_is_outstanding`) is one event dated when it was
    incurred; an installment item contributes one event per DUE cuota (not forgiven, not yet
    paid off, due on or before the statement date, ADR-215), dated by its due date. Upcoming
    cuotas are deliberately absent: they are not owed yet and are summed apart instead.
    """
    events: list[_LedgerEvent] = []
    for item in person.items:
        if item.installments:
            events.extend(
                _LedgerEvent(cuota.due_on, _cuota_detail(item, cuota, strings), cuota.remaining, is_payment=False)
                for cuota in item.installments
                if cuota.status == InstallmentStatus.DUE
            )
        elif _is_outstanding(item):
            events.append(_LedgerEvent(item.occurred_on, _item_detail(item), item.remaining, is_payment=False))
    return sorted(events, key=lambda event: event.occurred_on)


def _credit(person: PersonDetailReadModel) -> Decimal:
    """Return the credit the person holds — what was paid beyond items or cuotas still counted (ADR-206).

    The sum of the negative remainders of non-pardoned flat items and non-pardoned cuotas (due,
    or paid ahead beyond a later one): exactly what the due-only outstanding counts below the
    owed rows, so ``Σ owed rows + credit`` is the hero balance. Zero when there is no credit.
    """
    credit = Decimal(0)
    for item in person.items:
        if item.installments:
            credit += sum(
                (cuota.remaining for cuota in item.installments if not cuota.pardoned and cuota.remaining < 0),
                Decimal(0),
            )
        elif not item.pardoned and item.remaining < 0:
            credit += item.remaining
    return credit


def _build_outstanding_rows(person: PersonDetailReadModel, strings: _LocaleStrings) -> tuple[LedgerRow, ...]:
    """Format what is owed now as the outstanding-only ledger (ADR-212, the default mode).

    Lists ONLY what is still owed (:func:`_owed_events` — the owed flat items and the due cuotas),
    date-ascending, each at its REMAINING amount (what is left to pay, not the gross charge). The
    Saldo column carries the cumulative remaining; a credit the person holds (:func:`_credit`)
    closes the list as a "Saldo a favor" row, so the last row lands on the person's
    authoritative due-only outstanding (ADR-215). There are no payment rows in this mode; a
    person who owes nothing yet and holds no credit yields an empty tuple, which the template
    turns into the calm empty state.
    """
    rows: list[LedgerRow] = []
    running = Decimal(0)
    for event in _owed_events(person, strings):
        running += event.amount
        rows.append(
            LedgerRow(
                occurred_on=_format_date(event.occurred_on, strings),
                detail=event.detail,
                amount=_format_number(event.amount, strings),
                balance=_format_number(running, strings),
                is_payment=False,
            )
        )
    credit = _credit(person)
    if credit < Decimal(0):
        running += credit
        rows.append(
            LedgerRow(
                occurred_on=_NO_DATE,
                detail=strings.credit_label,
                amount=f"{_MINUS} {_format_number(-credit, strings)}",
                balance=_format_number(running, strings),
                is_payment=True,
            )
        )
    return tuple(rows)


def _covered_rows(person: PersonDetailReadModel, strings: _LocaleStrings) -> tuple[CoveredRow, ...]:
    """List what the owner forgave for the covered box, in both modes (ADR-210, ADR-221).

    A pardoned flat item shows at its remainder at pardon (:func:`_is_covered`); an installment
    item shows each forgiven cuota that still had something to forgive, at that cuota's
    remainder and dated by its due date.
    """
    rows: list[CoveredRow] = []
    for item in person.items:
        if item.installments:
            rows.extend(
                CoveredRow(
                    occurred_on=_format_date(cuota.due_on, strings),
                    detail=_cuota_detail(item, cuota, strings),
                    amount=_format_number(cuota.remaining, strings),
                )
                for cuota in item.installments
                if cuota.pardoned and cuota.remaining > Decimal(0)
            )
        elif _is_covered(item):
            rows.append(
                CoveredRow(
                    occurred_on=_format_date(item.occurred_on, strings),
                    detail=_item_detail(item),
                    amount=_format_number(item.remaining, strings),
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
    full_history: bool = False,
    today: date,
) -> StatementView:
    """Assemble the pure, localized :class:`StatementView` for a person's statement (ADR-211/212/222).

    Pre-formats every displayed value as a locale-aware string:

    - The hero shows the authoritative ``person.outstanding`` (ADR-206), which counts only the
      cuotas already due (ADR-215), split into a large integer part and a small fractional part.
    - The 3-stat bar shows total consumed (Σ non-pardoned item amounts, or non-forgiven cuota
      amounts for an installment item), paid so far (Σ payments), and outstanding (the
      authoritative total). These all-time context stats are identical in both modes.
    - The informational upcoming strip shows ``person.upcoming_total`` (the not-yet-due cuotas,
      ADR-215) in both modes, apart from the hero; it is omitted when nothing is upcoming.
    - The ledger depends on ``full_history`` (ADR-212). Default (``False``, outstanding-only):
      only what is owed now (the still-owed flat items and the due cuotas, ADR-222) at their
      REMAINING amount, date-ascending, with a cumulative-remaining Saldo and NO payment rows.
      Full history (``True``): non-pardoned charges and every cuota (``+``) interleaved with
      payments (``−``) date-ascending at their gross amounts, with upcoming and forgiven cuotas
      listed but kept out of the Saldo. Either way the ledger closes on "Saldo a la fecha" = the
      authoritative outstanding, and the empty outstanding-only ledger renders the calm empty
      state instead.
    - The covered box lists pardoned items and forgiven cuotas with their covered amount in
      BOTH modes; it is omitted when the person has none.
    - The footer carries the owner (dropped gracefully when unknown) and the complaints clause;
      the page template's ``{page}``/``{pages}`` are substituted for live CSS counters at PDF
      time.

    Cuota statuses are read from ``person``, which the reader assessed as of the statement date
    (the request's injected "today", ADR-223); the builder itself never reads the clock.

    Args:
        person: The person-detail read model (name, outstanding, upcoming, items, payments).
        owner_name: The current owner's display name for the footer; the empty string drops the
            "por {owner}" suffix gracefully.
        lang: The active document locale (``es`` or ``en``); defaults to Spanish.
        full_history: When ``False`` (the default) the ledger is outstanding-only; when ``True``
            it is the full running-balance history (charges + payment rows) as ADR-211 shipped.
        today: The emission date shown in the header (injected for deterministic rendering).

    Returns:
        The render-agnostic :class:`StatementView` the template consumes.
    """
    strings = _STRINGS[lang]
    ledger_rows = _build_ledger_rows(person, strings) if full_history else _build_outstanding_rows(person, strings)
    total_consumed = sum((_consumed(item) for item in person.items), Decimal(0))
    total_paid = sum((payment.amount for payment in person.payments), Decimal(0))
    hero_main, hero_frac = _split_hero_amount(person.outstanding, strings)
    covered_rows = _covered_rows(person, strings)
    return StatementView(
        lang=lang,
        full_history=full_history,
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
        show_upcoming=person.upcoming_total > Decimal(0),
        upcoming_label=strings.upcoming_label,
        upcoming_value=_format_number(person.upcoming_total, strings),
        upcoming_note=strings.upcoming_note,
        details_title=strings.details_title,
        col_date=strings.col_date,
        col_detail=strings.col_detail,
        col_amount=strings.col_amount,
        col_balance=strings.col_balance,
        ledger_rows=ledger_rows,
        balance_to_date_label=strings.balance_to_date,
        balance_to_date_value=_format_number(person.outstanding, strings),
        empty_state=strings.empty_state,
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
        raise RuntimeError("WeasyPrint returned no PDF bytes.")  # noqa: TRY003
    return pdf


def build_statement_pdf(
    person: PersonDetailReadModel,
    *,
    owner_name: str = "",
    lang: Locale = _DEFAULT_LOCALE,
    full_history: bool = False,
    today: date,
) -> bytes:
    """Build the downloadable receivable-statement PDF bytes for a person (ADR-211/212/222).

    Composes the three layers: pure view model, template-to-HTML, then the WeasyPrint adapter.
    The single entry point the download route calls.

    Args:
        person: The person-detail read model to render.
        owner_name: The current owner's display name for the footer; empty drops it gracefully.
        lang: The active document locale (``es`` or ``en``); defaults to Spanish.
        full_history: When ``False`` (the default) the document is outstanding-only; when
            ``True`` it renders the full running-balance history (ADR-212).
        today: The emission date shown in the header.

    Returns:
        The rendered PDF document as bytes.
    """
    view = build_statement_view(person, owner_name=owner_name, lang=lang, full_history=full_history, today=today)
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
