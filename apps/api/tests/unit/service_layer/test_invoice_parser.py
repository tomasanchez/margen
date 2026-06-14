"""Unit tests for the pure ARCA invoice parser logic (ADR-069, ADR-074).

These exercise the parser's pure surface with plain bytes, strings, Decimals and
dates — no native ``zbar``/PyMuPDF, no HTTP, no SQL (ADR-032/074). The native
boundary (:func:`decode_qr_payloads` / :func:`extract_text`) is the *only* thing
mocked, via ``monkeypatch``, so the fast-tier coverage gate needs no native
stack. They prove: the AFIP QR URL extraction + base64url JSON decode, the
field-mapping to a transaction draft (ARS direct vs non-ARS USD/FX block), the
text-fallback client-name scrape, the natural-key derivation, and the three
:class:`ParseStatus` outcomes.
"""

from __future__ import annotations

import base64
import json
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest

from margen_api.domain.models.value_objects import Currency, FxRateType, Kind
from margen_api.service_layer import invoice_parser
from margen_api.service_layer.invoice_parser import (
    decode_qr_payloads,
    derive_client_name,
    extract_afip_qr_data,
    extract_text,
    extract_words,
    parse_invoice,
    to_transaction_input,
)
from margen_api.service_layer.invoice_parser_read_models import (
    ArcaQrData,
    ParsedInvoice,
    ParseStatus,
)

# A representative AFIP QR JSON payload (camelCase keys as AFIP emits them).
_SAMPLE_QR_JSON = {
    "ver": 1,
    "fecha": "2026-06-12",
    "cuit": "20304050607",
    "ptoVta": 5,
    "tipoCmp": 11,
    "nroCmp": 1234,
    "importe": "150000.50",
    "moneda": "PES",
    "ctz": "1",
    "tipoCodAut": "E",
    "codAut": "70123456789012",
    "nroDocRec": "27111111114",
}


def _afip_qr_url(payload: dict[str, Any]) -> str:
    """Build a real AFIP QR URL by base64url-encoding the JSON payload."""
    raw = json.dumps(payload).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"https://www.afip.gob.ar/fe/qr/?p={encoded}"


def _parsed(qr: ArcaQrData | None, *, status: ParseStatus, client_name: str | None = None) -> ParsedInvoice:
    """Build a :class:`ParsedInvoice` for the mapping tests."""
    return ParsedInvoice(
        status=status,
        qr=qr,
        extracted_text="",
        client_name=client_name,
        natural_key=None,
    )


class TestExtractAfipQrData:
    """extract_afip_qr_data decodes a valid AFIP QR and rejects everything else."""

    def test_decodes_valid_afip_qr_into_typed_fields(self):
        """
        GIVEN a valid AFIP QR URL payload carrying a base64url JSON document
        WHEN the QR data is extracted
        THEN every field is coerced to its typed form (Decimal money, parsed date)
        """
        # GIVEN
        payloads = [_afip_qr_url(_SAMPLE_QR_JSON)]

        # WHEN
        data = extract_afip_qr_data(payloads)

        # THEN
        assert data is not None
        assert data.ver == 1
        assert data.fecha == date(2026, 6, 12)
        assert data.cuit == "20304050607"
        assert data.pto_vta == 5
        assert data.tipo_cmp == 11
        assert data.nro_cmp == 1234
        assert data.importe == Decimal("150000.50")
        assert data.moneda == "PES"
        assert data.ctz == Decimal("1")
        assert data.tipo_cod_aut == "E"
        assert data.cod_aut == "70123456789012"
        assert data.nro_doc_rec == "27111111114"

    def test_accepts_the_arca_rebranded_host(self):
        """
        GIVEN a QR on the current ARCA domain (arca.gob.ar, ex-AFIP)
        WHEN the QR data is extracted
        THEN it is decoded just like the legacy afip.gob.ar host
        """
        # GIVEN — real comprobantes now carry arca.gob.ar, not afip.gob.ar.
        raw = json.dumps(_SAMPLE_QR_JSON).encode("utf-8")
        encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        arca_url = f"https://www.arca.gob.ar/fe/qr/?p={encoded}"

        # WHEN
        data = extract_afip_qr_data([arca_url])

        # THEN
        assert data is not None
        assert data.cuit == "20304050607"
        assert data.importe == Decimal("150000.50")

    def test_finds_afip_url_embedded_in_a_larger_payload(self):
        """
        GIVEN a payload that contains the AFIP URL preceded by other text
        WHEN the QR data is extracted
        THEN the embedded AFIP URL is located and decoded
        """
        # GIVEN
        payloads = [f"noise-prefix {_afip_qr_url(_SAMPLE_QR_JSON)}"]

        # WHEN
        data = extract_afip_qr_data(payloads)

        # THEN
        assert data is not None
        assert data.cuit == "20304050607"

    def test_decodes_unpadded_base64url(self):
        """
        GIVEN an AFIP QR whose base64url 'p' value carries no '=' padding
        WHEN the QR data is extracted
        THEN the padding-tolerant decode still succeeds
        """
        # GIVEN — _afip_qr_url already strips padding; assert it round-trips.
        url = _afip_qr_url(_SAMPLE_QR_JSON)
        assert "=" not in url.split("p=", 1)[1]

        # WHEN
        data = extract_afip_qr_data([url])

        # THEN
        assert data is not None
        assert data.nro_cmp == 1234

    def test_no_afip_payload_returns_none(self):
        """
        GIVEN payloads with no AFIP QR URL (or an empty list)
        WHEN the QR data is extracted
        THEN it returns None
        """
        assert extract_afip_qr_data([]) is None
        assert extract_afip_qr_data(["https://example.com/not-afip"]) is None

    def test_afip_url_without_p_param_returns_none(self):
        """
        GIVEN an AFIP QR URL missing the 'p' query parameter
        WHEN the QR data is extracted
        THEN it returns None
        """
        assert extract_afip_qr_data(["https://www.afip.gob.ar/fe/qr/?x=1"]) is None

    def test_malformed_base64_returns_none(self):
        """
        GIVEN an AFIP QR URL whose 'p' value is not valid base64
        WHEN the QR data is extracted
        THEN it returns None
        """
        assert extract_afip_qr_data(["https://www.afip.gob.ar/fe/qr/?p=!!!not-base64!!!"]) is None

    def test_bad_json_returns_none(self):
        """
        GIVEN an AFIP QR URL whose decoded 'p' value is not JSON
        WHEN the QR data is extracted
        THEN it returns None
        """
        # GIVEN — base64url of the plain (non-JSON) bytes b"hello".
        encoded = base64.urlsafe_b64encode(b"hello").decode("ascii").rstrip("=")
        assert extract_afip_qr_data([f"https://www.afip.gob.ar/fe/qr/?p={encoded}"]) is None

    def test_json_array_payload_returns_none(self):
        """
        GIVEN an AFIP QR whose decoded JSON is an array, not an object
        WHEN the QR data is extracted
        THEN it returns None (only JSON objects are accepted)
        """
        # GIVEN
        encoded = base64.urlsafe_b64encode(b"[1, 2, 3]").decode("ascii").rstrip("=")

        # THEN
        assert extract_afip_qr_data([f"https://www.afip.gob.ar/fe/qr/?p={encoded}"]) is None

    def test_coercion_tolerates_missing_and_unusable_fields(self):
        """
        GIVEN an AFIP QR with absent, boolean, and unparseable scalar fields
        WHEN the QR data is extracted
        THEN the unusable fields coerce to None without raising
        """
        # GIVEN — ver is a bool, importe is non-numeric, fecha is malformed, others absent.
        payload = {"ver": True, "importe": "not-a-number", "fecha": "12/06/2026", "cuit": "  "}

        # WHEN
        data = extract_afip_qr_data([_afip_qr_url(payload)])

        # THEN
        assert data is not None
        assert data.ver is None
        assert data.importe is None
        assert data.fecha is None
        assert data.cuit is None
        assert data.pto_vta is None

    def test_numeric_strings_and_floats_coerce(self):
        """
        GIVEN an AFIP QR carrying numeric strings and a float importe
        WHEN the QR data is extracted
        THEN ints coerce from strings and Decimal coerces from a float string
        """
        # GIVEN
        payload = {"ptoVta": "7", "nroCmp": "99", "importe": 1234.56}

        # WHEN
        data = extract_afip_qr_data([_afip_qr_url(payload)])

        # THEN
        assert data is not None
        assert data.pto_vta == 7
        assert data.nro_cmp == 99
        assert data.importe == Decimal("1234.56")

    def test_uncoercible_scalars_become_none(self):
        """
        GIVEN an AFIP QR with a non-numeric int field and a boolean importe
        WHEN the QR data is extracted
        THEN the bad int coerces to None and the boolean importe is rejected (not 1)
        """
        # GIVEN — ptoVta is not an integer; importe is a JSON bool (must not become Decimal(1)).
        payload = {"ptoVta": "not-a-number", "importe": True}

        # WHEN
        data = extract_afip_qr_data([_afip_qr_url(payload)])

        # THEN
        assert data is not None
        assert data.pto_vta is None
        assert data.importe is None


class TestToTransactionInput:
    """to_transaction_input maps QR fields to the create-input draft (ADR-068)."""

    def test_ars_invoice_maps_amount_directly(self):
        """
        GIVEN a parsed ARS invoice with a client name
        WHEN it is mapped to a transaction draft
        THEN amount is importe, currency is ARS, kind is invoice, counting is on,
             and no FX block is filled
        """
        # GIVEN
        qr = extract_afip_qr_data([_afip_qr_url(_SAMPLE_QR_JSON)])
        parsed = _parsed(qr, status=ParseStatus.OK_QR, client_name="Acme SRL")

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.amount == Decimal("150000.50")
        assert draft.currency == Currency.ARS.value
        assert draft.kind == Kind.INVOICE.value
        assert draft.counts_toward_monotributo is True
        assert draft.name == "Acme SRL"
        assert draft.occurred_on == date(2026, 6, 12)
        assert draft.usd_amount is None
        assert draft.fx_rate is None
        assert draft.fx_rate_type is None
        assert draft.fx_rate_as_of is None

    def test_ars_code_is_also_treated_as_pesos(self):
        """
        GIVEN a parsed invoice whose moneda is the literal 'ARS'
        WHEN it is mapped
        THEN it is treated as ARS (no FX block)
        """
        # GIVEN
        qr = extract_afip_qr_data([_afip_qr_url({**_SAMPLE_QR_JSON, "moneda": "ARS"})])
        parsed = _parsed(qr, status=ParseStatus.OK_QR, client_name="Acme SRL")

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.currency == Currency.ARS.value
        assert draft.usd_amount is None

    def test_missing_client_name_falls_back_to_invoice_number(self):
        """
        GIVEN a parsed invoice with no scraped client name
        WHEN it is mapped
        THEN the name is the 'Invoice <ptoVta>-<nroCmp>' fallback
        """
        # GIVEN
        qr = extract_afip_qr_data([_afip_qr_url(_SAMPLE_QR_JSON)])
        parsed = _parsed(qr, status=ParseStatus.OK_QR, client_name=None)

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.name == "Invoice 5-1234"

    @pytest.mark.parametrize("moneda", ["DOL", "USD"])
    def test_foreign_invoice_fills_the_usd_fx_block(self, moneda: str):
        """
        GIVEN a parsed non-ARS invoice (e.g. moneda 'DOL'/'USD') with a quotation
        WHEN it is mapped
        THEN currency is USD, usd_amount is importe, the official FX block is filled,
             and amount is the ARS-equivalent importe*ctz rounded to two places
        """
        # GIVEN — 1000 USD at 1180.5 -> 1_180_500.00 ARS.
        payload = {**_SAMPLE_QR_JSON, "moneda": moneda, "importe": "1000", "ctz": "1180.5"}
        qr = extract_afip_qr_data([_afip_qr_url(payload)])
        parsed = _parsed(qr, status=ParseStatus.OK_QR, client_name="Foreign Client")

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.currency == Currency.USD.value
        assert draft.usd_amount == Decimal("1000")
        assert draft.fx_rate == Decimal("1180.5")
        assert draft.fx_rate_type == FxRateType.OFFICIAL.value
        assert draft.fx_rate_as_of == date(2026, 6, 12)
        assert draft.amount == Decimal("1180500.00")

    def test_foreign_invoice_without_figures_leaves_amount_none(self):
        """
        GIVEN a non-ARS invoice missing importe and ctz
        WHEN it is mapped
        THEN currency is USD but the ARS-equivalent amount is None (not computable)
        """
        # GIVEN — moneda foreign, no importe/ctz.
        payload = {"moneda": "DOL", "ptoVta": 1, "nroCmp": 2}
        qr = extract_afip_qr_data([_afip_qr_url(payload)])
        parsed = _parsed(qr, status=ParseStatus.OK_QR, client_name=None)

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.currency == Currency.USD.value
        assert draft.amount is None
        assert draft.name == "Invoice 1-2"

    def test_no_qr_yields_an_empty_ars_draft(self):
        """
        GIVEN a parsed invoice with no QR (text fallback)
        WHEN it is mapped
        THEN it is a calm empty ARS draft with the None-None fallback name
        """
        # GIVEN
        parsed = _parsed(None, status=ParseStatus.OK_TEXT_FALLBACK, client_name=None)

        # WHEN
        draft = to_transaction_input(parsed)

        # THEN
        assert draft.currency == Currency.ARS.value
        assert draft.amount is None
        assert draft.name == "Invoice None-None"


def _word(text: str, x0: float, *, y: float = 100.0, width: float = 20.0) -> tuple:
    """Build a PyMuPDF-shaped word tuple (x0, y0, x1, y1, word, block, line, word_no).

    Only the coordinates and the word text drive :func:`derive_client_name`; the
    block/line/word_no trailers are filler to match the native tuple shape.
    """
    return (x0, y, x0 + width, y + 9.0, text, 0, 0, 0)


class TestDeriveClientName:
    """derive_client_name reads the receptor name from word coordinates (issue #26).

    The receptor sits on one physical line split into label/value columns; the name
    is the words to the RIGHT of the receptor label on that same line. The issuer's
    bare 'Razón Social:' must never be picked.
    """

    def test_senor_es_label_value_to_the_right_same_line(self):
        """
        GIVEN a 'Señor(es):' label with the value words to its right on one line
              (mirroring the real two-column ARCA layout)
        WHEN the client name is derived
        THEN the right-of-label words join into the client name
        """
        # GIVEN — label at x≈24..68, value "Deel," "Inc." to the right, all y≈177;
        # a next-column "Domicilio:" label sits further right and must be excluded.
        words = [
            _word("Señor(es):", 24.0, y=177.0, width=44.0),
            _word("Deel,", 79.0, y=177.0, width=21.0),
            _word("Inc.", 102.0, y=177.0, width=15.0),
            _word("Domicilio:", 265.0, y=177.0, width=43.0),
            _word("425", 314.0, y=177.0),
            _word("Street", 346.0, y=177.0),
        ]

        # WHEN / THEN
        assert derive_client_name(words, None) == "Deel, Inc."

    def test_standard_apellido_razon_social_receptor_label(self):
        """
        GIVEN the standard 'Apellido y Nombre / Razón Social:' receptor label with
              the client value to its right on the same line
        WHEN the client name is derived
        THEN the client value is returned
        """
        # GIVEN — the multi-word receptor label, then the value to its right.
        words = [
            _word("Apellido", 24.0, y=177.0, width=40.0),
            _word("y", 66.0, y=177.0, width=6.0),
            _word("Nombre", 74.0, y=177.0, width=35.0),
            _word("/", 111.0, y=177.0, width=4.0),
            _word("Razón", 117.0, y=177.0, width=27.0),
            _word("Social:", 146.0, y=177.0, width=30.0),
            _word("Acme", 200.0, y=177.0, width=30.0),
            _word("SRL", 232.0, y=177.0, width=22.0),
        ]

        # WHEN / THEN
        assert derive_client_name(words, None) == "Acme SRL"

    def test_issuer_only_razon_social_is_not_picked(self):
        """
        GIVEN only the issuer's bare 'Razón Social:' label (the emisor block) and
              no receptor label
        WHEN the client name is derived
        THEN it returns None — the issuer name is never mistaken for the client
        """
        # GIVEN — the emisor's "Razón Social: SANCHEZ TOMAS AGUSTIN" line.
        words = [
            _word("Razón", 24.0, y=108.0, width=27.0),
            _word("Social:", 53.0, y=108.0, width=30.0),
            _word("SANCHEZ", 85.0, y=108.0, width=43.0),
            _word("TOMAS", 130.0, y=108.0, width=32.0),
            _word("AGUSTIN", 165.0, y=108.0, width=40.0),
        ]

        # WHEN / THEN
        assert derive_client_name(words, None) is None

    def test_label_with_no_value_to_the_right_returns_none(self):
        """
        GIVEN a receptor label with no word to its right on the line
        WHEN the client name is derived
        THEN it returns None
        """
        words = [_word("Señor(es):", 24.0, y=177.0, width=44.0)]
        assert derive_client_name(words, None) is None

    def test_empty_words_returns_none(self):
        """
        GIVEN no words at all
        WHEN the client name is derived
        THEN it returns None
        """
        assert derive_client_name([], None) is None

    def test_no_known_label_returns_none(self):
        """
        GIVEN words with no known receptor label
        WHEN the client name is derived
        THEN it returns None
        """
        words = [_word("Random", 24.0), _word("body", 60.0)]
        assert derive_client_name(words, None) is None

    def test_multiple_lines_and_value_word_at_label_edge(self):
        """
        GIVEN words across two physical lines (an emisor line above the receptor
              line) plus a stray value word that does NOT sit right of the label
        WHEN the client name is derived
        THEN the words are bucketed into the correct lines and only the words truly
             right of the receptor label form the name
        """
        # GIVEN — line A (y=108) is an unrelated emisor row; line B (y=177) is the
        # receptor. A word whose x0 is at/left of the label's right edge is ignored.
        words = [
            _word("CUIT:", 24.0, y=108.0, width=24.0),
            _word("20999", 60.0, y=108.0, width=40.0),
            _word("Señor(es):", 24.0, y=177.0, width=44.0),
            _word("clipped", 40.0, y=177.0, width=10.0),  # x0 < label right edge (68) -> skipped
            _word("Globex", 79.0, y=177.0, width=35.0),
            _word("SA", 117.0, y=177.0, width=18.0),
        ]

        # WHEN / THEN
        assert derive_client_name(words, None) == "Globex SA"

    def test_unordered_words_are_grouped_by_line(self):
        """
        GIVEN the receptor words supplied out of order (and a repeated header line
              from a second page sharing the same y)
        WHEN the client name is derived
        THEN they are grouped by their y-coordinate and the name is still read,
             de-duplicated across the repeated page header
        """
        # GIVEN — value words before the label, plus a duplicate page-2 copy.
        words = [
            _word("Inc.", 102.0, y=177.0, width=15.0),
            _word("Señor(es):", 24.0, y=177.0, width=44.0),
            _word("Deel,", 79.0, y=177.0, width=21.0),
            # Exact-duplicate header from another page (same x/y/text).
            _word("Señor(es):", 24.0, y=177.0, width=44.0),
            _word("Deel,", 79.0, y=177.0, width=21.0),
            _word("Inc.", 102.0, y=177.0, width=15.0),
        ]

        # WHEN / THEN
        assert derive_client_name(words, None) == "Deel, Inc."


class TestParseInvoiceStatus:
    """parse_invoice orchestrates the native + pure steps into a ParseStatus.

    The native boundary is mocked via monkeypatch so no zbar/PyMuPDF is needed.
    """

    def test_qr_present_yields_ok_qr_and_natural_key(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a PDF whose decode yields an AFIP QR and whose text carries the name
        WHEN the invoice is parsed
        THEN the status is OK_QR, the QR is decoded, the name scraped and the
             natural key derived
        """
        # GIVEN — the receptor name lives in the word coordinates, not the flat text.
        url = _afip_qr_url(_SAMPLE_QR_JSON)
        receptor_words = [
            _word("Señor(es):", 24.0, y=177.0, width=44.0),
            _word("Acme", 79.0, y=177.0, width=30.0),
            _word("SRL", 112.0, y=177.0, width=22.0),
        ]
        monkeypatch.setattr(invoice_parser, "decode_qr_payloads", lambda _pdf: [url])
        monkeypatch.setattr(invoice_parser, "extract_text", lambda _pdf: "ignored flat text")
        monkeypatch.setattr(invoice_parser, "extract_words", lambda _pdf: receptor_words)

        # WHEN
        parsed = parse_invoice(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.OK_QR
        assert parsed.qr is not None
        assert parsed.client_name == "Acme SRL"
        assert parsed.natural_key is not None
        assert parsed.natural_key.emisor_cuit == "20304050607"
        assert parsed.natural_key.pto_vta == 5
        assert parsed.natural_key.tipo_cmp == 11
        assert parsed.natural_key.nro_cmp == 1234

    def test_no_qr_but_text_yields_text_fallback(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a PDF with no decodable QR but with extractable text
        WHEN the invoice is parsed
        THEN the status is OK_TEXT_FALLBACK, with no QR and no natural key
        """
        # GIVEN
        monkeypatch.setattr(invoice_parser, "decode_qr_payloads", lambda _pdf: [])
        monkeypatch.setattr(invoice_parser, "extract_text", lambda _pdf: "Plain invoice text")
        monkeypatch.setattr(invoice_parser, "extract_words", lambda _pdf: [])

        # WHEN
        parsed = parse_invoice(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.OK_TEXT_FALLBACK
        assert parsed.qr is None
        assert parsed.natural_key is None

    def test_neither_qr_nor_text_yields_unparseable(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a PDF with neither a decodable QR nor extractable text
        WHEN the invoice is parsed
        THEN the status is UNPARSEABLE (a calm outcome, not an error)
        """
        # GIVEN
        monkeypatch.setattr(invoice_parser, "decode_qr_payloads", lambda _pdf: [])
        monkeypatch.setattr(invoice_parser, "extract_text", lambda _pdf: "   \n  ")
        monkeypatch.setattr(invoice_parser, "extract_words", lambda _pdf: [])

        # WHEN
        parsed = parse_invoice(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.UNPARSEABLE
        assert parsed.qr is None

    def test_qr_with_no_natural_key_fields_yields_none_natural_key(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a QR that decodes but carries none of the natural-key fields
        WHEN the invoice is parsed
        THEN the status is OK_QR yet the natural key is None
        """
        # GIVEN — a QR object present but with all four key fields absent.
        payload = {"importe": "100", "moneda": "PES"}
        url = _afip_qr_url(payload)
        monkeypatch.setattr(invoice_parser, "decode_qr_payloads", lambda _pdf: [url])
        monkeypatch.setattr(invoice_parser, "extract_text", lambda _pdf: "")
        monkeypatch.setattr(invoice_parser, "extract_words", lambda _pdf: [])

        # WHEN
        parsed = parse_invoice(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.OK_QR
        assert parsed.natural_key is None


class _FakePage:
    """A stand-in PyMuPDF page exposing the text, words, and pixmap the boundary uses."""

    def __init__(self, text: str, words: list[tuple] | None = None) -> None:
        self._text = text
        self._words = words or []

    def get_text(self, kind: str = "text") -> str | list[tuple]:
        """Return the page's canned text, or its words when asked for ``"words"``."""
        if kind == "words":
            return self._words
        return self._text

    def get_pixmap(self, *, matrix: object, colorspace: object) -> SimpleNamespace:
        """Return a tiny canned grayscale pixmap (matrix/colorspace accepted, ignored)."""
        del matrix, colorspace
        return SimpleNamespace(samples=b"\x00", width=1, height=1)


def _fake_fitz_open(pages: list[_FakePage]):
    """Build a ``fitz.open`` replacement yielding a context-managed document."""

    @contextmanager
    def _open(*, stream: bytes, filetype: str):
        del stream, filetype
        yield pages

    return _open


class TestNativeBoundary:
    """The native-isolated functions, exercised with ``fitz``/``pyzbar`` mocked.

    ADR-074 keeps the native ``zbar``/PyMuPDF stack out of the fast tier. These
    swap the module-level ``fitz``/``pyzbar`` names so the boundary's own glue is
    covered without the native libraries; the real decode is proven only in the
    integration tier.
    """

    def test_extract_text_concatenates_page_text(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a PDF document of two text pages (fitz mocked)
        WHEN the text is extracted
        THEN the page texts are concatenated newline-separated
        """
        # GIVEN
        pages = [_FakePage("page one"), _FakePage("page two")]
        monkeypatch.setattr(invoice_parser, "fitz", SimpleNamespace(open=_fake_fitz_open(pages)))

        # WHEN / THEN
        assert extract_text(b"%PDF-fake") == "page one\npage two"

    def test_extract_words_flattens_word_tuples_across_pages(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a two-page PDF whose pages each yield word tuples (fitz mocked)
        WHEN the words are extracted
        THEN every page's word tuples are returned in one flat list
        """
        # GIVEN
        page_one_words = [(0.0, 0.0, 10.0, 9.0, "alpha", 0, 0, 0)]
        page_two_words = [(0.0, 0.0, 10.0, 9.0, "beta", 0, 0, 0)]
        pages = [_FakePage("p1", page_one_words), _FakePage("p2", page_two_words)]
        monkeypatch.setattr(invoice_parser, "fitz", SimpleNamespace(open=_fake_fitz_open(pages)))

        # WHEN / THEN
        assert extract_words(b"%PDF-fake") == [*page_one_words, *page_two_words]

    def test_decode_qr_payloads_decodes_each_symbol(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a PDF page whose pixmap zbar decodes into two QR symbols (mocked)
        WHEN the QR payloads are decoded
        THEN each symbol's UTF-8 data is returned
        """
        # GIVEN — fitz yields one page; Matrix + csGRAY are no-op stand-ins.
        pages = [_FakePage("ignored")]
        fake_fitz = SimpleNamespace(open=_fake_fitz_open(pages), Matrix=lambda _x, _y: object(), csGRAY=object())
        monkeypatch.setattr(invoice_parser, "fitz", fake_fitz)

        # pyzbar receives the (pixels, width, height) grayscale tuple; the fake
        # ignores it and returns canned symbols.
        decoded_images: list[object] = []
        symbols = [SimpleNamespace(data=b"first"), SimpleNamespace(data=b"second")]
        monkeypatch.setattr(
            invoice_parser,
            "pyzbar",
            SimpleNamespace(decode=lambda image: (decoded_images.append(image), symbols)[1]),
        )

        # WHEN
        payloads = decode_qr_payloads(b"%PDF-fake")

        # THEN — each symbol's UTF-8 data is returned, and pyzbar got a 3-tuple.
        assert payloads == ["first", "second"]
        assert decoded_images == [(b"\x00", 1, 1)]
