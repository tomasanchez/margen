"""Real-decode guard for the ARCA invoice parser (issue #26, ADR-074).

The fast tiers mock the ``fitz``/``pyzbar`` boundary, so they cannot catch the
real-stack failures we hit on actual comprobantes: the page render being too
low-resolution for zbar, the QR's ARCA domain, and pyzbar's pixel-tuple input
contract. This test exercises the genuine path end to end — it generates a real
QR PDF (``qrcode`` + PyMuPDF) and decodes it through the unmocked parser.

Marked ``integration`` (ADR-032): it needs the native ``zbar`` library and is
excluded from the coverage gate; the API CI integration job installs ``libzbar0``.
It is skipped when ``zbar`` is unavailable so offline/Windows-less runs stay green.
"""

from __future__ import annotations

import base64
import io
import json
from datetime import date
from decimal import Decimal
from typing import Any

import fitz
import pytest

from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer import invoice_parser
from margen_api.service_layer.invoice_parser import decode_qr_payloads, parse_invoice, to_transaction_input
from margen_api.service_layer.invoice_parser_read_models import ParseStatus

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(invoice_parser.pyzbar is None, reason="native zbar library not installed"),
]

# A SYNTHETIC ARCA export-invoice QR payload (USD). All identifiers and figures
# are fabricated test data — not a real taxpayer, CUIT, CAE, or invoice.
_QR_JSON = {
    "ver": 1,
    "fecha": "2026-01-15",
    "cuit": 20000000001,
    "ptoVta": 1,
    "tipoCmp": 19,
    "nroCmp": 1,
    "importe": 1000.00,
    "moneda": "DOL",
    "ctz": 1200,
    "tipoCodAut": "E",
    "codAut": 70000000000001,
}


def _arca_qr_pdf() -> bytes:
    """Build a one-page PDF carrying a real ARCA QR (current arca.gob.ar host)."""
    import qrcode

    encoded = base64.urlsafe_b64encode(json.dumps(_QR_JSON).encode()).decode().rstrip("=")
    url = f"https://www.arca.gob.ar/fe/qr/?p={encoded}"
    buffer = io.BytesIO()
    # qrcode.make returns a PIL-backed image (pillow dev dep); type as Any since
    # the checker resolves the pure-python backend whose save() lacks `format`.
    image: Any = qrcode.make(url)
    image.save(buffer, format="PNG")

    document = fitz.open()
    page = document.new_page()
    # Place the QR small on the page (as ARCA does) so the render-resolution path
    # is genuinely exercised — a too-low zoom would fail to resolve it.
    page.insert_image(fitz.Rect(60, 60, 180, 180), stream=buffer.getvalue())
    pdf = document.tobytes()
    document.close()
    return bytes(pdf)


class TestRealQrDecode:
    """The unmocked parser decodes a genuine ARCA QR PDF end to end."""

    def test_decode_qr_payloads_finds_the_arca_url(self):
        """GIVEN a real QR PDF WHEN decoded THEN the ARCA fiscal URL is recovered."""
        payloads = decode_qr_payloads(_arca_qr_pdf())
        assert any("arca.gob.ar/fe/qr" in payload for payload in payloads)

    def test_parse_invoice_maps_the_usd_invoice(self):
        """
        GIVEN a real ARCA USD export-invoice QR PDF
        WHEN parsed through the unmocked stack
        THEN it resolves to OK_QR and maps to a USD invoice with the ARS-equivalent
        """
        parsed = parse_invoice(_arca_qr_pdf())

        assert parsed.status is ParseStatus.OK_QR
        assert parsed.qr is not None
        assert parsed.qr.importe == Decimal("1000.00")
        assert parsed.qr.moneda == "DOL"
        assert parsed.qr.fecha == date(2026, 1, 15)

        draft = to_transaction_input(parsed)
        assert draft.kind == Kind.INVOICE.value
        assert draft.currency == Currency.USD.value
        assert draft.usd_amount == Decimal("1000.00")
        assert draft.fx_rate == Decimal("1200")
        # ARS-equivalent amount = importe x ctz.
        assert draft.amount == Decimal("1200000.00")
