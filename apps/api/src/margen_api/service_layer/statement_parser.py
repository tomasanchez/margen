"""Credit-card statement PDF parser service module (ADR-076, ADR-079).

Takes PDF bytes and produces a :class:`ParsedStatement`: it extracts the PDF text
layer, finds the first bank parser whose fingerprint matches the document's own
text (CC statements carry no AFIP QR, unlike ARCA invoices — ADR-076), and runs
that parser to pull the statement metadata and the per-line expense drafts.

The native-library boundary is deliberately narrow so the fast test tier can mock
it without PyMuPDF installed (mirror ADR-069):

- :func:`extract_text` and :func:`extract_words` are the *only* functions that
  touch PyMuPDF (``fitz``). ``fitz`` is imported lazily inside them so unit tests
  can monkeypatch the text source without the native stack present.
- Everything else — the bank parser registry, the Galicia VISA parser, the number/
  date helpers, the fee-netting, and the category guesser — is PURE: it operates on
  the extracted text string and is fully unit-testable from plain strings.

This module performs NO persistence and NO HTTP calls (ADR-076, ADR-078).
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from datetime import date
from decimal import Decimal, InvalidOperation

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.statement_parser_read_models import (
    LineKind,
    ParsedStatement,
    ParseStatus,
    StatementLineDraft,
    StatementNaturalKey,
)

log = logging.getLogger(__name__)

# Galicia bank (issuer) CUIT — the primary Galicia VISA fingerprint marker (ADR-076).
_GALICIA_CUIT = "30-50000173-5"

# Middot used to compose the payment-method label "Galicia VISA ·5771" (ADR-079).
_MIDDOT = "·"

# Spanish three-letter month abbreviations (as printed, lowercased) to month number.
_MONTHS_ES: dict[str, int] = {
    "ene": 1,
    "feb": 2,
    "mar": 3,
    "abr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "ago": 8,
    "sep": 9,
    "set": 9,
    "oct": 10,
    "nov": 11,
    "dic": 12,
}


# --------------------------------------------------------------------------- #
# Native-isolated functions (PyMuPDF). Mock THESE in fast unit tests.          #
# --------------------------------------------------------------------------- #


def extract_text(pdf_bytes: bytes) -> str:
    """Extract and concatenate the text of every page of a PDF.

    Native boundary: uses PyMuPDF (``fitz``), imported lazily so pure callers and
    the fast test tier can mock the text source without the native stack (ADR-076).

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        The concatenated page text (empty string when the PDF carries no text).
    """
    import fitz  # PyMuPDF; native PDF text extraction (lazy import — ADR-076).

    parts: list[str] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            parts.append(str(page.get_text()))
    return "\n".join(parts)


def extract_words(pdf_bytes: bytes) -> list[tuple]:
    """Extract every word of a PDF with its bounding box, across all pages.

    Native boundary: uses PyMuPDF (``fitz``), imported lazily. Each tuple is
    ``(x0, y0, x1, y1, word, block_no, line_no, word_no)`` (PyMuPDF's
    ``page.get_text("words")`` shape). Reserved for future coordinate-aware bank
    parsers; the Galicia VISA parser works off the flat text layer. Isolated here
    so the fast test tier can mock the word source without the native stack.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        A flat list of word-coordinate tuples (empty when the PDF carries no text).
    """
    import fitz  # PyMuPDF; native PDF word extraction (lazy import — ADR-076).

    words: list[tuple] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            page_words: list[tuple] = list(page.get_text("words"))  # type: ignore[arg-type]
            words.extend(page_words)
    return words


# --------------------------------------------------------------------------- #
# Pure helpers (no I/O). Unit-testable without native libraries.               #
# --------------------------------------------------------------------------- #


def _parse_ar_decimal(value: str) -> Decimal | None:
    """Parse an Argentine-formatted money string into a :class:`Decimal` (PURE).

    Argentine format uses ``.`` as the thousands separator and ``,`` as the decimal
    separator (e.g. ``1.133.243,99`` → ``Decimal("1133243.99")``). A leading ``-``
    is preserved so fee waivers keep their sign (ADR-079).

    Args:
        value: The money token as printed on the statement.

    Returns:
        The parsed :class:`Decimal`, or ``None`` when the token is not numeric.
    """
    token = value.strip().replace(".", "").replace(",", ".")
    try:
        return Decimal(token)
    except (InvalidOperation, ValueError):
        return None


def _parse_dmy(value: str) -> date | None:
    """Parse a ``DD-MM-YY`` statement date into a :class:`date` (PURE).

    The two-digit year is interpreted as ``20YY`` (statements are contemporary).

    Args:
        value: The date token (e.g. ``"20-03-26"``).

    Returns:
        The parsed :class:`date`, or ``None`` when malformed.
    """
    match = re.fullmatch(r"(\d{2})-(\d{2})-(\d{2})", value.strip())
    if match is None:
        return None
    day, month, year = (int(group) for group in match.groups())
    try:
        return date(2000 + year, month, day)
    except ValueError:
        return None


def _parse_d_mon_y(value: str) -> date | None:
    """Parse a ``DD-Mon-YY`` statement date (Spanish month) into a :class:`date`.

    Args:
        value: The date token (e.g. ``"11-Jun-26"``).

    Returns:
        The parsed :class:`date`, or ``None`` when the month or numbers are invalid.
    """
    match = re.fullmatch(r"(\d{2})-([A-Za-z]{3})-(\d{2})", value.strip())
    if match is None:
        return None
    day_token, month_token, year_token = match.groups()
    month = _MONTHS_ES.get(month_token.lower())
    if month is None:
        return None
    try:
        return date(2000 + int(year_token), month, int(day_token))
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Category guesser (PURE). Small, obvious keyword map, editable downstream.     #
# --------------------------------------------------------------------------- #

# Ordered keyword → category map (ADR-079). The first keyword found (case-insensitive)
# in the merchant text wins; kept deliberately small and obvious. Default is None.
_CATEGORY_KEYWORDS: tuple[tuple[str, str], ...] = (
    # "passline" (event ticketing) → Entertainment. Bare "merpago" (Mercado Pago,
    # a payment processor) is deliberately NOT mapped — it is too ambiguous to
    # categorize; such a charge stays uncategorized for the user to set at review.
    ("passline", "Entertainment"),
    ("giesso", "Shopping"),
    ("cardon", "Shopping"),
    ("equus", "Shopping"),
    ("rochas", "Shopping"),
    ("viniaurbana", "Shopping"),
    ("vinia urbana", "Shopping"),
    ("sube", "Transport"),
    ("sushi", "Food"),
    ("express", "Food"),
)


def guess_category(name: str) -> str | None:
    """Guess a category from the merchant text via a small keyword map (PURE).

    Args:
        name: The merchant / reference text.

    Returns:
        The matched category, or ``None`` when no keyword applies. The guess is a
        convenience the review UI can override (ADR-079).
    """
    haystack = name.lower()
    for keyword, category in _CATEGORY_KEYWORDS:
        if keyword in haystack:
            return category
    return None


# --------------------------------------------------------------------------- #
# Bank parser registry (ADR-076).                                              #
# --------------------------------------------------------------------------- #


class StatementParser(ABC):
    """A bank-specific statement parser plugged into the registry (ADR-076).

    Each concrete parser fingerprints the extracted text for its issuer's markers
    and, when matched, extracts the statement metadata and line drafts. New banks
    are additive — they register in :data:`BANK_PARSERS` with no caller changes.
    """

    @abstractmethod
    def fingerprint(self, text: str) -> bool:
        """Return whether the extracted text belongs to this issuer (ADR-076)."""

    @abstractmethod
    def parse(self, text: str) -> ParsedStatement:
        """Extract the statement metadata and line drafts from matched text."""


class GaliciaVisaParser(StatementParser):
    """Parser for Banco Galicia VISA credit-card statements (ADR-076, ADR-079).

    Fingerprints on the Galicia issuer CUIT plus VISA / Galicia branding. Parses
    the statement number, card last-4, period dates, total, the DETALLE DEL CONSUMO
    purchase lines, and the bank fee/waiver rows (netting waived fees to zero).
    Works entirely off the flat text layer so it is pure and unit-testable.
    """

    # PyMuPDF emits the statement table as a VERTICAL token stream — one cell per
    # line (date, marker, merchant, cuota, comprobante, pesos, dolares each on its
    # own line), not flat rows. The parser therefore assembles rows from standalone
    # cell tokens (ADR-076 layout). The following match a single cell each.
    #
    # An Argentine money cell: thousands dots + decimal comma, optional leading sign.
    _MONEY_TOKEN = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d{2}$")
    # A standalone DD-MM-YY date cell (starts every purchase/fee row).
    _DATE_TOKEN = re.compile(r"^\d{2}-\d{2}-\d{2}$")
    # A standalone cuota cell such as "03/03".
    _CUOTA_TOKEN = re.compile(r"^\d{2}/\d{2}$")
    # A standalone comprobante (voucher) reference cell — 4-7 bare digits.
    _COMPROBANTE_TOKEN = re.compile(r"^\d{4,7}$")
    # A standalone consumption-marker cell ("*" or "K") preceding the merchant.
    _MARKER_TOKEN = re.compile(r"^[*K]$", re.IGNORECASE)
    # A page-number cell such as "1 / 5".
    _PAGE_NUMBER = re.compile(r"^\d+\s*/\s*\d+$")
    # A barcode / document-id cell (a long digit run, optional trailing letter).
    _BARCODE = re.compile(r"^\d{12,}[A-Za-z]?$")

    # The six dd-Mon-yy period tokens printed together near the header.
    _PERIOD_DATES = re.compile(
        r"(\d{2}-[A-Za-z]{3}-\d{2})\s+(\d{2}-[A-Za-z]{3}-\d{2})\s+"
        r"(\d{2}-[A-Za-z]{3}-\d{2})\s+(\d{2}-[A-Za-z]{3}-\d{2})\s+"
        r"(\d{2}-[A-Za-z]{3}-\d{2})\s+(\d{2}-[A-Za-z]{3}-\d{2})"
    )
    _STATEMENT_NUMBER = re.compile(r"Resumen\s+N[°º]\s*([A-Z0-9]+)", re.IGNORECASE)
    _CARD_LAST4 = re.compile(r"TARJETA\s+(\d{4})\b", re.IGNORECASE)
    _TOTAL = re.compile(r"TOTAL\s+A\s+PAGAR[^\d\-]*(-?\d{1,3}(?:\.\d{3})*,\d{2})", re.IGNORECASE)

    # Section anchors in the vertical token stream.
    _DETAIL_HEADER = "DETALLE DEL CONSUMO"  # purchases start after this header.
    _CONSUMO_TOTAL_PREFIX = "TARJETA "  # "TARJETA 5771 Total Consumos…" ends purchases.
    _GRAND_TOTAL = "TOTAL A PAGAR"  # ends the fee/charges block.

    # Rows that must never become transactions (payments / carryover — ADR-079).
    _SKIP_MARKERS = ("SU PAGO", "SALDO ANTERIOR")
    # Repeating page-header / column-title chrome cells to ignore while assembling
    # rows (the header block reprints on every page, splitting the fee section).
    _NOISE_PREFIXES = (
        "RESUMEN N",
        "TARJETA CRÉDITO",
        "TARJETA CREDITO",
        "CONSUMIDOR FINAL",
        "CUIT BANCO",
        "N° CUENTA",
        "Nº CUENTA",
        "SUCURSAL",
        "RESUMEN DE TARJETA",
        "PÁGINA",
        "PAGINA",
        "FECHA",
        "REFERENCIA",
        "CUOTA",
        "COMPROBANTE",
        "PESOS",
        "DÓLARES",
        "DOLARES",
    )

    def fingerprint(self, text: str) -> bool:
        """Detect a Galicia VISA statement by its issuer markers (ADR-076)."""
        lowered = text.lower()
        has_galicia = _GALICIA_CUIT in text or "galicia" in lowered
        has_visa = "visa" in lowered
        return has_galicia and has_visa

    def parse(self, text: str) -> ParsedStatement:
        """Extract Galicia VISA statement metadata and line drafts (ADR-079)."""
        statement_number = self._first_group(self._STATEMENT_NUMBER, text)
        card_last4 = self._first_group(self._CARD_LAST4, text)
        period_close, period_due = self._periods(text)
        total_amount = self._total(text)
        payment_method = self._payment_method(card_last4)

        tokens = [raw.strip() for raw in text.splitlines()]
        # ADR-089: every line's occurred_on is the statement pay/due date. When the
        # statement carries no parseable due date, each line falls back to its own
        # purchase date so a line is never lost or left with a None occurred_on.
        lines = self._line_items(tokens, period_due) + self._fee_lines(tokens, period_due)

        natural_key = StatementNaturalKey(
            issuer_cuit=_GALICIA_CUIT,
            card_last4=card_last4,
            statement_number=statement_number,
        )
        status = ParseStatus.OK if lines else ParseStatus.UNPARSEABLE
        return ParsedStatement(
            status=status,
            extracted_text=text,
            bank_name="Galicia",
            network="VISA",
            card_last4=card_last4,
            payment_method=payment_method,
            statement_number=statement_number,
            issuer_cuit=_GALICIA_CUIT,
            period_close=period_close,
            period_due=period_due,
            total_amount=total_amount,
            natural_key=natural_key,
            lines=lines,
        )

    @staticmethod
    def _first_group(pattern: re.Pattern[str], text: str) -> str | None:
        """Return the first capture group of ``pattern`` in ``text``, or ``None``."""
        match = pattern.search(text)
        return match.group(1) if match is not None else None

    @staticmethod
    def _payment_method(card_last4: str | None) -> str:
        """Compose the ``"Galicia VISA ·5771"`` payment-method label (ADR-079)."""
        suffix = f" {_MIDDOT}{card_last4}" if card_last4 else ""
        return f"Galicia VISA{suffix}"

    def _periods(self, text: str) -> tuple[date | None, date | None]:
        """Pull (period_close, period_due) from the six dd-Mon-yy header tokens.

        The header prints six dates: cierre anterior, venc anterior, cierre actual,
        venc actual, próximo cierre, próximo venc. The current close is the 3rd and
        the current due is the 4th (ADR brief). Parsed defensively — when the
        six-token run is absent both are ``None``.
        """
        match = self._PERIOD_DATES.search(text)
        if match is None:
            return None, None
        return _parse_d_mon_y(match.group(3)), _parse_d_mon_y(match.group(4))

    def _total(self, text: str) -> Decimal | None:
        """Pull the pesos ``TOTAL A PAGAR`` figure, or ``None``."""
        token = self._first_group(self._TOTAL, text)
        return _parse_ar_decimal(token) if token is not None else None

    def _is_noise(self, token: str) -> bool:
        """Return whether a cell is blank or repeating page chrome to ignore.

        The page header (statement number, cardholder, account, "Página N / N",
        the barcode) and the table column titles reprint on every page, splitting
        the fee section across a page break. These cells must never be folded into
        a row's merchant/fee label while assembling the vertical token stream.
        """
        if not token:
            return True
        # A cuota cell ("03/03") looks like a page number ("1 / 5") — never drop it.
        if self._CUOTA_TOKEN.match(token):
            return False
        upper = token.upper()
        if any(upper.startswith(prefix) for prefix in self._NOISE_PREFIXES):
            return True
        return bool(self._PAGE_NUMBER.match(token) or self._BARCODE.match(token))

    def _section(self, tokens: list[str], start_prefix: str, end_prefix: str) -> list[str]:
        """Return the cells strictly between the first ``start_prefix`` cell and the
        first following ``end_prefix`` cell (or end of stream)."""
        start = next(
            (i for i, t in enumerate(tokens) if t.upper().startswith(start_prefix)),
            None,
        )
        if start is None:
            return []
        end = next(
            (i for i in range(start + 1, len(tokens)) if tokens[i].upper().startswith(end_prefix)),
            len(tokens),
        )
        return tokens[start + 1 : end]

    def _line_items(self, tokens: list[str], pay_date: date | None) -> list[StatementLineDraft]:
        """Parse the DETALLE DEL CONSUMO purchase rows into drafts (ADR-079, ADR-089).

        Within the detail section, each purchase is a run of standalone cells —
        ``DD-MM-YY`` / ``* | K`` / merchant / ``NN/NN`` (optional) / comprobante /
        pesos / dolares (optional) — that a flat regex cannot see (the bug fixed
        here). Rows are grouped on the leading date cell and classified by cell. Each
        draft's ``occurred_on`` is the statement ``pay_date`` (ADR-089); ``pay_date``
        of ``None`` falls back to the row's own purchase date.
        """
        detail = self._section(tokens, self._DETAIL_HEADER, self._CONSUMO_TOTAL_PREFIX)
        drafts: list[StatementLineDraft] = []
        for group in self._row_groups(detail):
            draft = self._build_purchase(group, pay_date)
            if draft is not None:
                drafts.append(draft)
        return drafts

    def _row_groups(self, tokens: list[str]) -> list[list[str]]:
        """Group a section's cells into rows, each starting at a date cell.

        Blank and page-chrome cells are dropped so a page break inside the section
        never contaminates a row.
        """
        groups: list[list[str]] = []
        current: list[str] | None = None
        for token in tokens:
            if self._is_noise(token):
                continue
            if self._DATE_TOKEN.match(token):
                if current is not None:
                    groups.append(current)
                current = [token]
            elif current is not None:
                current.append(token)
        if current is not None:
            groups.append(current)
        return groups

    def _build_purchase(self, group: list[str], pay_date: date | None) -> StatementLineDraft | None:
        """Build one purchase draft from a grouped row of standalone cells (ADR-089).

        The row's leading date cell is the original purchase date (``purchase_date``);
        ``occurred_on`` is the statement ``pay_date`` (the due date the charge is
        debited), falling back to ``purchase_date`` when no pay date was parsed.
        """
        purchase_date = _parse_dmy(group[0])
        if purchase_date is None:
            return None
        occurred_on = pay_date if pay_date is not None else purchase_date

        cells = group[1:]
        if cells and self._MARKER_TOKEN.match(cells[0]):
            cells = cells[1:]  # drop the "*" / "K" consumption marker cell.

        money = [c for c in cells if self._MONEY_TOKEN.match(c)]
        if not money:
            return None

        cuota = next((c for c in cells if self._CUOTA_TOKEN.match(c)), None)
        name = " ".join(c for c in cells if self._is_name_cell(c)).strip()
        if not name or self._is_skip_row(name):
            return None

        pesos = _parse_ar_decimal(money[0])
        if pesos is None:  # pragma: no cover - _MONEY_TOKEN pre-filter guarantees a parseable amount
            return None

        # A second money cell is the DÓLARES column → USD line (ADR-079). The sample
        # has none; fx is left for manual confirmation (fx_rate_type=None).
        if len(money) >= 2:
            usd = _parse_ar_decimal(money[1])
            return StatementLineDraft(
                occurred_on=occurred_on,
                purchase_date=purchase_date,
                name=name,
                amount=abs(pesos),
                currency=Currency.USD,
                line_kind=LineKind.PURCHASE,
                usd_amount=abs(usd) if usd is not None else None,
                fx_rate=None,
                fx_rate_type=None,
                category=guess_category(name),
                cuota=cuota,
            )

        return StatementLineDraft(
            occurred_on=occurred_on,
            purchase_date=purchase_date,
            name=name,
            amount=abs(pesos),
            currency=Currency.ARS,
            line_kind=LineKind.PURCHASE,
            category=guess_category(name),
            cuota=cuota,
        )

    def _is_name_cell(self, cell: str) -> bool:
        """Return whether a cell is part of the merchant name (not a structured cell)."""
        return not (
            self._MONEY_TOKEN.match(cell)
            or self._CUOTA_TOKEN.match(cell)
            or self._COMPROBANTE_TOKEN.match(cell)
            or self._MARKER_TOKEN.match(cell)
        )

    def _is_skip_row(self, name: str) -> bool:
        """Return whether a row is a payment / carryover row to skip (ADR-079).

        Payment (``SU PAGO``) and carryover (``SALDO ANTERIOR``) rows must never
        become transactions — recording them would double-count (ADR-079). They sit
        outside the detail section, so this is a defensive guard.
        """
        upper = name.upper()
        return any(marker in upper for marker in self._SKIP_MARKERS)

    @staticmethod
    def _looks_like_fee(label: str) -> bool:
        """Return whether a label cell names a bank fee/charge rather than a purchase.

        Fee rows print a ``COM``/``BONI`` (and similar) label cell; purchases carry
        a merchant name instead.
        """
        upper = label.upper()
        return upper.startswith(("COM ", "BONI ", "INT ", "IVA ", "SEGURO", "IMPUESTO"))

    def _fee_lines(self, tokens: list[str], pay_date: date | None) -> list[StatementLineDraft]:
        """Parse and net the bank fee/waiver rows into drafts (ADR-079, ADR-089).

        Fees sit between the consumo total and ``TOTAL A PAGAR`` as date / label /
        amount cell runs, split across a page break (the COM charge on one page, its
        BONI waiver on the next). For each date cell the next fee-label cell and the
        following money cell are paired (skipping page chrome), then summed per
        normalised label root. A FEE draft is emitted only when the netted sum is
        positive; a fully-waived fee (sum == 0) produces no line. Each draft's
        ``occurred_on`` is the statement ``pay_date`` (ADR-089) and its
        ``purchase_date`` is the fee row's own date; ``pay_date`` of ``None`` falls
        back to that row date.
        """
        region = self._section(tokens, self._CONSUMO_TOTAL_PREFIX, self._GRAND_TOTAL)
        sums: dict[str, Decimal] = {}
        dates: dict[str, date] = {}
        labels: dict[str, str] = {}

        index = 0
        while index < len(region):
            if not self._DATE_TOKEN.match(region[index]):
                index += 1
                continue
            occurred_on = _parse_dmy(region[index])
            label_at = self._next_meaningful(region, index + 1)
            if occurred_on is None or label_at is None or not self._looks_like_fee(region[label_at]):
                index += 1
                continue
            label = " ".join(region[label_at].split()).strip()
            money_at = self._next_money(region, label_at + 1)
            if money_at is None:
                index = label_at + 1
                continue
            amount = _parse_ar_decimal(region[money_at])
            if amount is not None:  # pragma: no branch - _MONEY_TOKEN pre-filter guarantees parseable
                root = self._fee_root(label)
                sums[root] = sums.get(root, Decimal("0")) + amount
                dates[root] = occurred_on
                labels.setdefault(root, label)
            index = money_at + 1

        return [
            StatementLineDraft(
                occurred_on=pay_date if pay_date is not None else dates[root],
                purchase_date=dates[root],
                name=labels[root],
                amount=net,
                currency=Currency.ARS,
                line_kind=LineKind.FEE,
                category=None,
                cuota=None,
            )
            for root, net in sums.items()
            if net > Decimal("0")
        ]

    def _next_meaningful(self, tokens: list[str], start: int) -> int | None:
        """Index of the next non-noise cell at/after ``start``, or ``None``."""
        for i in range(start, len(tokens)):
            if not self._is_noise(tokens[i]):
                return i
        return None

    def _next_money(self, tokens: list[str], start: int) -> int | None:
        """Index of the next money cell at/after ``start``, stopping at the next date."""
        for i in range(start, len(tokens)):
            if self._DATE_TOKEN.match(tokens[i]):
                return None
            if self._MONEY_TOKEN.match(tokens[i]):
                return i
        return None

    @staticmethod
    def _fee_root(label: str) -> str:
        """Normalise a fee label to its root by dropping the COM/BONI prefix.

        Pairs the charge (``COM MANT CTA Y RENO``) with its waiver
        (``BONI MANT CTA Y RENO``) under one key so they net (ADR-079).
        """
        upper = label.upper()
        for prefix in ("COM ", "BONI "):
            if upper.startswith(prefix):
                return upper[len(prefix) :].strip()
        return upper


# Module-level registry of bank parsers. New banks are additive (ADR-076).
BANK_PARSERS: list[StatementParser] = [GaliciaVisaParser()]


def parse_statement(pdf_bytes: bytes) -> ParsedStatement:
    """Parse a credit-card statement PDF into a structured result (ADR-076, ADR-078).

    Orchestrates the native and pure steps: extract the text layer, find the first
    registered bank parser whose fingerprint matches the document's own text, and
    run it. When no parser matches, returns a calm ``UNSUPPORTED`` result so the UI
    offers manual entry (ADR-080) — never an error. A matched parser that raises or
    extracts nothing yields ``UNPARSEABLE``; the caller never sees an exception.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        The parsed result, always carrying ``extracted_text`` and the status, plus
        the bank identity and line drafts when a parser matched.
    """
    text = extract_text(pdf_bytes)
    for parser in BANK_PARSERS:
        if not parser.fingerprint(text):
            continue
        try:
            parsed = parser.parse(text)
        except Exception:
            log.exception("Bank parser %s failed on a matched statement", type(parser).__name__)
            return ParsedStatement(status=ParseStatus.UNPARSEABLE, extracted_text=text)
        return parsed
    return ParsedStatement(status=ParseStatus.UNSUPPORTED, extracted_text=text)
