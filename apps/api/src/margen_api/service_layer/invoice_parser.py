"""ARCA invoice PDF parser service module (ADR-069, ADR-068).

Takes PDF bytes and produces a :class:`ParsedInvoice`: it decodes the embedded
AFIP QR code (the authoritative, self-describing source of the fiscal fields) and
falls back to PDF text extraction for the receptor/client name and for invoices
without a usable QR.

The native-library boundary is deliberately narrow so the fast test tier can mock
it without ``zbar`` installed:

- :func:`extract_text`, :func:`extract_words`, and :func:`decode_qr_payloads` are
  the *only* functions that touch PyMuPDF (``fitz``) and ``pyzbar``.
- :func:`extract_afip_qr_data`, :func:`derive_client_name`, and
  :func:`to_transaction_input` are PURE: no I/O, fully unit-testable from plain
  strings, word-coordinate tuples, and dataclasses.

The receptor/client name lives in a two-column layout that flat
:func:`extract_text` reorders, so :func:`derive_client_name` reads the value to
the *right* of the receptor label using the word coordinates from
:func:`extract_words` (issue #26).

This module performs NO persistence and NO HTTP calls (ADR-069).
"""

from __future__ import annotations

import base64
import binascii
import json
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qs, urlparse

import fitz  # PyMuPDF; native PDF rendering + text extraction (ADR-069).

try:
    from pyzbar import pyzbar  # Wraps the native `zbar` library for QR decoding.
except (ImportError, OSError):  # pragma: no cover - native zbar absent in CI/test envs
    # The native `zbar` shared library may be missing where the QR decode is never
    # exercised for real (the fast tiers mock this boundary, ADR-074); the module
    # must still import. `pyzbar` stays a module attribute so tests can patch it,
    # and the runtime image installs `zbar` so real decoding works (deploy follow-up).
    pyzbar = None  # type: ignore[assignment]

from margen_api.domain.models.value_objects import Currency, FxRateType, Kind
from margen_api.service_layer.invoice_parser_read_models import (
    ArcaQrData,
    InvoiceNaturalKey,
    InvoiceTransactionDraft,
    ParsedInvoice,
    ParseStatus,
)

# AFIP QR URL host/path used to recognize the fiscal QR among any decoded payloads.
# The fiscal QR URL prefixes. ARCA (ex-AFIP) rebranded the domain, so current
# comprobantes carry arca.gob.ar while older ones carry afip.gob.ar; accept both.
_AFIP_QR_URL_PREFIXES = (
    "https://www.arca.gob.ar/fe/qr/",
    "https://www.afip.gob.ar/fe/qr/",
)

# ARCA QR `moneda` codes that mean Argentine pesos; anything else is treated as a
# foreign currency mapped to USD (ADR-068 only models ARS vs USD).
_ARS_MONEDA_CODES = frozenset({"ARS", "PES"})

# Default category for an imported invoice; editable at the confirm step (ADR-068).
_DEFAULT_INVOICE_CATEGORY = "Services"

# RECEPTOR-specific labels that precede the client name, in PREFERENCE order. These
# are deliberately distinct from the issuer's bare "Razón Social:" label so the
# emisor block is never picked (issue #26): the "Señor(es)" family identifies the
# receptor unambiguously, and the standard receptor variant always pairs the name
# with "Apellido y Nombre". Each label is given as its normalized words so we can
# match a run of adjacent words on a physical line regardless of casing/accents.
_RECEPTOR_NAME_LABELS: tuple[tuple[str, ...], ...] = (
    ("senor(es):",),
    ("senores:",),
    ("senor/es:",),
    ("apellido", "y", "nombre", "/", "razon", "social:"),
    ("apellido", "y", "nombre", "/", "razon", "social"),
    ("apellido", "y", "nombre:"),
    ("apellido", "y", "nombre"),
)

# Vertical tolerance (PDF points) for treating two words as sharing one physical
# line; ARCA glyphs on a line vary by < 1pt in y, so a small band is ample.
_LINE_Y_TOLERANCE = 3.0

# Word indices in a PyMuPDF ``page.get_text("words")`` tuple
# ``(x0, y0, x1, y1, word, block_no, line_no, word_no)``.
_WORD_X0, _WORD_Y0, _WORD_X1, _WORD_Y1, _WORD_TEXT = 0, 1, 2, 3, 4

# Tokens that, when met after the label on the same physical line, mark the start
# of the NEXT column (e.g. "Domicilio:") so the client value stops cleanly.
_NEXT_COLUMN_TOKENS = frozenset({"domicilio:", "domicilio"})


# --------------------------------------------------------------------------- #
# Native-isolated functions (PyMuPDF / pyzbar). Mock THESE in fast unit tests.  #
# --------------------------------------------------------------------------- #


def extract_text(pdf_bytes: bytes) -> str:
    """Extract and concatenate the text of every page of a PDF.

    Native boundary: uses PyMuPDF (``fitz``). Isolated here so pure callers and the
    fast test tier can mock the text source without the native stack.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        The concatenated page text (empty string when the PDF carries no text).
    """
    parts: list[str] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            parts.append(str(page.get_text()))
    return "\n".join(parts)


def extract_words(pdf_bytes: bytes) -> list[tuple]:
    """Extract every word of a PDF with its bounding box, across all pages.

    Native boundary: uses PyMuPDF (``fitz``). Each tuple is
    ``(x0, y0, x1, y1, word, block_no, line_no, word_no)`` (PyMuPDF's
    ``page.get_text("words")`` shape). Unlike flat :func:`extract_text`, the
    coordinates preserve the physical two-column layout, which
    :func:`derive_client_name` needs to read the value to the *right* of the
    receptor label (issue #26). Isolated here so the fast test tier can mock the
    word source without the native stack.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        A flat list of word-coordinate tuples (empty when the PDF carries no text).
    """
    words: list[tuple] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            # get_text("words") returns the word-coordinate tuples; the cast pins
            # the type for pyrefly since the overload is a broad union.
            page_words: list[tuple] = list(page.get_text("words"))  # type: ignore[arg-type]
            words.extend(page_words)
    return words


def decode_qr_payloads(pdf_bytes: bytes) -> list[str]:
    """Render each page to an image and decode any QR codes found.

    Native boundary: uses PyMuPDF (``fitz``) to rasterize pages and ``pyzbar`` to
    decode QR barcodes. Isolated here so :func:`extract_afip_qr_data` can stay pure
    and the fast test tier can mock the decode boundary without ``zbar``.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        The decoded QR string payloads across all pages (possibly empty).
    """
    if pyzbar is None:  # pragma: no cover - zbar is present at runtime; mocked in fast tests
        raise RuntimeError("the native zbar library is required to decode invoice QR codes")
    payloads: list[str] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            # Render at 4x GRAYSCALE: the fiscal QR is small on an A4 page, so a
            # lower zoom leaves zbar too few pixels to resolve the modules (2x
            # decodes nothing on real comprobantes; 4x is reliable). pyzbar's
            # no-NumPy/PIL path accepts a (pixels, width, height) tuple of 8-bpp
            # luminance bytes, which a csGRAY pixmap's `samples` provides directly.
            pixmap = page.get_pixmap(matrix=fitz.Matrix(4, 4), colorspace=fitz.csGRAY)
            image = (pixmap.samples, pixmap.width, pixmap.height)
            for symbol in pyzbar.decode(image):
                payloads.append(symbol.data.decode("utf-8", errors="replace"))
    return payloads


# --------------------------------------------------------------------------- #
# Pure functions (no I/O). Unit-testable without native libraries.             #
# --------------------------------------------------------------------------- #


def _decode_base64url_json(encoded: str) -> dict[str, Any] | None:
    """Base64url-decode (padding-tolerant) and JSON-parse an AFIP QR ``p`` value.

    Args:
        encoded: The ``p`` query-parameter value from the AFIP QR URL.

    Returns:
        The decoded JSON object, or ``None`` when decoding or parsing fails or the
        payload is not a JSON object.
    """
    # base64url alphabet uses '-'/'_'; restore '+'/'/' and pad to a multiple of 4.
    padded = encoded + "=" * (-len(encoded) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
        decoded = json.loads(raw)
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    return decoded


def _find_afip_qr_url(payloads: list[str]) -> str | None:
    """Return the first payload that is/contains an AFIP QR URL, else ``None``.

    Args:
        payloads: Decoded QR string payloads.

    Returns:
        The AFIP QR URL when present in any payload, otherwise ``None``.
    """
    for payload in payloads:
        for prefix in _AFIP_QR_URL_PREFIXES:
            index = payload.find(prefix)
            if index != -1:
                return payload[index:].strip()
    return None


def _coerce_int(value: object) -> int | None:
    """Coerce a JSON scalar to ``int`` when possible, else ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str | float):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    return None


def _coerce_decimal(value: object) -> Decimal | None:
    """Coerce a JSON scalar to ``Decimal`` (ADR-025) when possible, else ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | str | float):
        try:
            return Decimal(str(value))
        except (TypeError, ValueError, InvalidOperation):
            return None
    return None


def _coerce_str(value: object) -> str | None:
    """Coerce a JSON scalar to a non-empty ``str``, else ``None``."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_fecha(value: object) -> date | None:
    """Parse an AFIP ``fecha`` (``YYYY-MM-DD``) into a :class:`date`, else ``None``."""
    text = _coerce_str(value)
    if text is None:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def extract_afip_qr_data(payloads: list[str]) -> ArcaQrData | None:
    """Find and decode the AFIP QR payload into :class:`ArcaQrData` (PURE).

    Locates the payload that is/contains the AFIP QR URL
    ``https://www.afip.gob.ar/fe/qr/?p=<base64url(JSON)>``, extracts the ``p`` query
    parameter, base64url-decodes it (padding-tolerant), JSON-parses it, and coerces
    the expected fields (Decimal money, parsed ``fecha``). Performs no I/O.

    Args:
        payloads: Decoded QR string payloads (e.g. from :func:`decode_qr_payloads`).

    Returns:
        The decoded :class:`ArcaQrData`, or ``None`` when no AFIP QR is present or
        the payload is malformed.
    """
    url = _find_afip_qr_url(payloads)
    if url is None:
        return None

    query = parse_qs(urlparse(url).query)
    p_values = query.get("p")
    if not p_values:
        return None

    data = _decode_base64url_json(p_values[0])
    if data is None:
        return None

    return ArcaQrData(
        ver=_coerce_int(data.get("ver")),
        fecha=_parse_fecha(data.get("fecha")),
        cuit=_coerce_str(data.get("cuit")),
        pto_vta=_coerce_int(data.get("ptoVta")),
        tipo_cmp=_coerce_int(data.get("tipoCmp")),
        nro_cmp=_coerce_int(data.get("nroCmp")),
        importe=_coerce_decimal(data.get("importe")),
        moneda=_coerce_str(data.get("moneda")),
        ctz=_coerce_decimal(data.get("ctz")),
        tipo_cod_aut=_coerce_str(data.get("tipoCodAut")),
        cod_aut=_coerce_str(data.get("codAut")),
        nro_doc_rec=_coerce_str(data.get("nroDocRec")),
    )


def _normalize_token(word: str) -> str:
    """Lowercase and strip accents from a word for case/accent-insensitive matching.

    Args:
        word: A raw word as emitted by PyMuPDF.

    Returns:
        The word folded to lowercase ASCII (accents removed), preserving its
        punctuation so label colons (e.g. ``"señor(es):"``) still match.
    """
    decomposed = unicodedata.normalize("NFKD", word)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.lower()


def _group_words_into_lines(words: list[tuple]) -> list[list[tuple]]:
    """Group unordered word tuples into physical lines, left-to-right within a line.

    Words are bucketed by a vertical tolerance (:data:`_LINE_Y_TOLERANCE`) so that
    glyphs sharing one printed line land together even when the word list is
    unordered; each line is then sorted by ``x0``.

    Args:
        words: Word-coordinate tuples (PyMuPDF ``get_text("words")`` shape).

    Returns:
        Lines (lists of word tuples), each sorted left-to-right.
    """
    # Multi-page comprobantes repeat the header (receptor block) on every page, so
    # words at the same (x, y, text) recur; dedupe by rounded position+text so the
    # repeats don't multiply the joined client name.
    seen: set[tuple[float, float, str]] = set()
    unique: list[tuple] = []
    for word in words:
        key = (round(word[_WORD_X0], 1), round(word[_WORD_Y0], 1), str(word[_WORD_TEXT]))
        if key in seen:
            continue
        seen.add(key)
        unique.append(word)

    lines: list[list[tuple]] = []
    for word in sorted(unique, key=lambda w: (w[_WORD_Y0], w[_WORD_X0])):
        y0 = word[_WORD_Y0]
        for line in lines:
            if abs(line[0][_WORD_Y0] - y0) <= _LINE_Y_TOLERANCE:
                line.append(word)
                break
        else:
            lines.append([word])
    for line in lines:
        line.sort(key=lambda w: w[_WORD_X0])
    return lines


def _match_label_at(line: list[tuple], label: tuple[str, ...]) -> int | None:
    """Return the index just past ``label`` if the line starts with it, else ``None``.

    Args:
        line: The words of one physical line, left-to-right.
        label: The label as a tuple of normalized tokens.

    Returns:
        The index of the first word *after* the matched label run, or ``None`` when
        the line does not begin with the label.
    """
    if len(line) < len(label):
        return None
    for offset, expected in enumerate(label):
        if _normalize_token(line[offset][_WORD_TEXT]) != expected:
            return None
    return len(label)


def _client_name_from_line(line: list[tuple], value_start: int) -> str | None:
    """Join the words right of the label into a client name, stopping at the next column.

    Reads words at ``value_start`` onward whose ``x0`` lies right of the label,
    halting at the first next-column label token (e.g. ``"Domicilio:"``) so the
    adjacent address column never bleeds in. Trailing punctuation is trimmed.

    Args:
        line: The words of the receptor's physical line, left-to-right.
        value_start: Index of the first word after the label run.

    Returns:
        The client name, or ``None`` when no value words follow the label.
    """
    if value_start >= len(line):
        return None
    label_right_edge = line[value_start - 1][_WORD_X1]
    value_words: list[str] = []
    for word in line[value_start:]:
        if word[_WORD_X0] <= label_right_edge:
            continue
        if _normalize_token(word[_WORD_TEXT]) in _NEXT_COLUMN_TOKENS:
            break
        value_words.append(str(word[_WORD_TEXT]))
    name = " ".join(value_words).strip().rstrip(",;:")
    return name or None


def derive_client_name(words: list[tuple], qr: ArcaQrData | None) -> str | None:
    """Extract the receptor/client name from PDF word coordinates (PURE).

    The AFIP QR does not carry the human-readable receptor name, so it is read from
    the PDF (ADR-068). ARCA lays out the receptor on one physical line split into
    label/value columns, which flat text extraction reorders; here the words are
    grouped into lines by a y-tolerance and, for the first matched RECEPTOR label
    (preferring the unambiguous ``"Señor(es)"`` family), the value is the words to
    the right of the label on that same line — stopping before the next column.
    The issuer's bare ``"Razón Social:"`` is intentionally NOT in the receptor
    label set, so the emisor name is never picked (issue #26). Performs no I/O.

    Args:
        words: Word-coordinate tuples (e.g. from :func:`extract_words`), possibly
            unordered.
        qr: The decoded QR data, used only as a hint; currently unused for the name
            but kept in the signature so callers pass full parse context.

    Returns:
        The client name when confidently found, otherwise ``None``.
    """
    del qr  # Reserved for future heuristics; the name is not in the QR payload.
    if not words:
        return None

    lines = _group_words_into_lines(words)
    # Prefer labels in declared order so "Señor(es)" wins over the generic variant.
    for label in _RECEPTOR_NAME_LABELS:
        for line in lines:
            value_start = _match_label_at(line, label)
            if value_start is None:
                continue
            name = _client_name_from_line(line, value_start)
            if name is not None:
                return name
    return None


def _derive_natural_key(qr: ArcaQrData | None) -> InvoiceNaturalKey | None:
    """Build the fiscal natural key from QR data, or ``None`` when unavailable."""
    if qr is None:
        return None
    if qr.cuit is None and qr.pto_vta is None and qr.tipo_cmp is None and qr.nro_cmp is None:
        return None
    return InvoiceNaturalKey(
        emisor_cuit=qr.cuit,
        pto_vta=qr.pto_vta,
        tipo_cmp=qr.tipo_cmp,
        nro_cmp=qr.nro_cmp,
    )


def parse_invoice(pdf_bytes: bytes) -> ParsedInvoice:
    """Parse an ARCA invoice PDF into a structured :class:`ParsedInvoice`.

    Orchestrates the native and pure steps (ADR-069): decode QR payloads -> AFIP
    data; extract text (for the fallback status/stored text) and word coordinates;
    derive the client name from the words and the natural key. The status is
    ``OK_QR`` when QR data is decoded, ``OK_TEXT_FALLBACK`` when only text is
    available, and ``UNPARSEABLE`` when neither is obtained.

    Args:
        pdf_bytes: The raw PDF document bytes.

    Returns:
        The parsed result, always carrying ``extracted_text`` and a derived
        ``client_name`` / ``natural_key`` when possible.
    """
    payloads = decode_qr_payloads(pdf_bytes)
    qr = extract_afip_qr_data(payloads)
    text = extract_text(pdf_bytes)
    words = extract_words(pdf_bytes)
    client_name = derive_client_name(words, qr)
    natural_key = _derive_natural_key(qr)

    if qr is not None:
        status = ParseStatus.OK_QR
    elif text.strip():
        status = ParseStatus.OK_TEXT_FALLBACK
    else:
        status = ParseStatus.UNPARSEABLE

    return ParsedInvoice(
        status=status,
        qr=qr,
        extracted_text=text,
        client_name=client_name,
        natural_key=natural_key,
    )


# --------------------------------------------------------------------------- #
# Pure mapping helper to a transaction create-input draft (ADR-068).           #
# --------------------------------------------------------------------------- #

_TWO_PLACES = Decimal("0.01")


def to_transaction_input(parsed: ParsedInvoice) -> InvoiceTransactionDraft:
    """Map a parsed invoice to a transaction create-input draft (PURE, ADR-068).

    Produces values aligned with
    :class:`~margen_api.domain.commands.transaction.CreateTransaction` so the next
    task can feed them straight in. Money is :class:`~decimal.Decimal` (ADR-025).
    For a non-ARS invoice the FX block (ADR-044/045) is filled and ``amount`` is the
    ARS-equivalent ``importe * ctz`` rounded to two places; otherwise ``amount`` is
    ``importe`` directly. Performs no I/O.

    Args:
        parsed: The structured parse result.

    Returns:
        An :class:`InvoiceTransactionDraft` ready for the create path.
    """
    qr = parsed.qr
    importe = qr.importe if qr is not None else None
    ctz = qr.ctz if qr is not None else None
    moneda = qr.moneda if qr is not None else None
    occurred_on = qr.fecha if qr is not None else None

    is_foreign = moneda is not None and moneda.upper() not in _ARS_MONEDA_CODES

    if is_foreign:
        currency = Currency.USD.value
        usd_amount = importe
        fx_rate = ctz
        fx_rate_type: str | None = FxRateType.OFFICIAL.value
        fx_rate_as_of = occurred_on
        # ARS-equivalent magnitude; only computable when both figures are present.
        amount = (importe * ctz).quantize(_TWO_PLACES) if importe is not None and ctz is not None else None
    else:
        currency = Currency.ARS.value
        usd_amount = None
        fx_rate = None
        fx_rate_type = None
        fx_rate_as_of = None
        amount = importe

    return InvoiceTransactionDraft(
        occurred_on=occurred_on,
        name=parsed.client_name or _fallback_name(qr),
        kind=Kind.INVOICE.value,
        amount=amount,
        currency=currency,
        usd_amount=usd_amount,
        fx_rate=fx_rate,
        fx_rate_type=fx_rate_type,
        fx_rate_as_of=fx_rate_as_of,
        category=_DEFAULT_INVOICE_CATEGORY,
        counts_toward_monotributo=True,
    )


def _fallback_name(qr: ArcaQrData | None) -> str:
    """Build the ``"Invoice <ptoVta>-<nroCmp>"`` fallback name (ADR-068)."""
    pto_vta = qr.pto_vta if qr is not None else None
    nro_cmp = qr.nro_cmp if qr is not None else None
    return f"Invoice {pto_vta}-{nro_cmp}"
