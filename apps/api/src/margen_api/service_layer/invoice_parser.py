"""ARCA invoice PDF parser service module (ADR-069, ADR-068).

Takes PDF bytes and produces a :class:`ParsedInvoice`: it decodes the embedded
AFIP QR code (the authoritative, self-describing source of the fiscal fields) and
falls back to PDF text extraction for the receptor/client name and for invoices
without a usable QR.

The native-library boundary is deliberately narrow so the fast test tier can mock
it without ``zbar`` installed:

- :func:`extract_text` and :func:`decode_qr_payloads` are the *only* functions
  that touch PyMuPDF (``fitz``) and ``pyzbar``.
- :func:`extract_afip_qr_data`, :func:`derive_client_name`, and
  :func:`to_transaction_input` are PURE: no I/O, fully unit-testable from plain
  strings and dataclasses.

This module performs NO persistence and NO HTTP calls (ADR-069).
"""

from __future__ import annotations

import base64
import binascii
import json
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

# Best-effort labels that precede the receptor/client name in ARCA PDF text.
_CLIENT_NAME_LABELS = (
    "Apellido y Nombre / Razón Social",
    "Apellido y Nombre / Razon Social",
    "Razón Social",
    "Razon Social",
    "Apellido y Nombre",
    "Nombre y Apellido",
)


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


def derive_client_name(text: str, qr: ArcaQrData | None) -> str | None:
    """Best-effort extraction of the receptor/client name from PDF text (PURE).

    The AFIP QR does not carry the human-readable receptor name, so it is scraped
    from the PDF text (ADR-068). Looks for a known ARCA label and returns the value
    on the same line (after a colon) or the next non-empty line. Performs no I/O.

    Args:
        text: The extracted PDF text.
        qr: The decoded QR data, used only as a hint; currently unused for the name
            but kept in the signature so callers pass full parse context.

    Returns:
        The client name when confidently found, otherwise ``None``.
    """
    del qr  # Reserved for future heuristics; the name is not in the QR payload.
    if not text:
        return None

    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        for label in _CLIENT_NAME_LABELS:
            if not line.startswith(label):
                continue
            # Prefer an inline "Label: value" form.
            remainder = line[len(label) :].lstrip(" :\t")
            if remainder:
                return remainder
            # Otherwise take the next non-empty line.
            for candidate in lines[index + 1 :]:
                if candidate:
                    return candidate
            return None
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
    data; extract text; derive the client name and natural key. The status is
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
    client_name = derive_client_name(text, qr)
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
