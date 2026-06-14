"""Real-decode guard for the Galicia VISA statement parser (#29, ADR-082).

The fast tiers mock the ``fitz`` boundary, so they cannot catch a real PyMuPDF
text-extraction mismatch — exactly the bug that shipped first: PyMuPDF emits the
statement table as a VERTICAL token stream (one cell per line), which a flat-row
regex never matched. This test exercises the genuine path: it renders a SANITIZED
Galicia VISA statement to a real PDF (PyMuPDF) and parses it through the unmocked
stack, asserting the bank identity, the period, and the three purchase lines come
back with the netted fee dropped.

Marked ``integration`` (ADR-032/082): it needs the native PyMuPDF stack and is
excluded from the coverage gate. All identifiers and figures are fabricated test
data — never a real taxpayer, account, or statement (ADR-081).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import fitz
import pytest

from margen_api.service_layer.statement_parser import parse_statement
from margen_api.service_layer.statement_parser_read_models import LineKind, ParseStatus

pytestmark = pytest.mark.integration

# SANITIZED Galicia VISA statement cells, in the printed order — one PyMuPDF cell
# per entry (fake name/address/account; real structure). Three purchases summing
# to 14.521,66 and a COM/BONI MANT pair that nets to zero.
_CELLS: tuple[str, ...] = (
    "Resumen N° VI00000000069436867",
    "Tarjeta Crédito VISA",
    "JUAN PEREZ",
    "CUIT Banco: 30-50000173-5",
    "CALLE FALSA 123, CIUDAD AUTONOMA BUEN, C0000AAA",
    "N° Cuenta: 0000000000",
    "Sucursal: 665",
    "07-May-26",
    "15-May-26",
    "11-Jun-26",
    "19-Jun-26",
    "08-Jul-26",
    "17-Jul-26",
    "SALDO ANTERIOR",
    "612.544,09",
    "15-05-26",
    "SU PAGO EN PESOS",
    "-612.544,09",
    "DETALLE DEL CONSUMO",
    "FECHA",
    "REFERENCIA",
    "CUOTA",
    "COMPROBANTE",
    "PESOS",
    "20-03-26",
    "*",
    "MERPAGO*PASSLINE",
    "03/03",
    "524072",
    "3.641,66",
    "08-05-26",
    "K",
    "Express Av Cordoba 3721",
    "005306",
    "10.180,00",
    "14-05-26",
    "K",
    "SUBE VIAJES - BUSES",
    "501892",
    "700,00",
    "TARJETA 5771 Total Consumos de JUAN PEREZ",
    "14.521,66",
    "11-06-26",
    "COM MANT CTA Y RENO",
    "25.206,00",
    "11-06-26",
    "BONI MANT CTA Y RENO",
    "-25.206,00",
    "TOTAL A PAGAR",
    "14.521,66",
)


def _galicia_statement_pdf() -> bytes:
    """Render the sanitized cells to a real PDF, one cell per line.

    Each cell is placed on its own line at an increasing y so PyMuPDF's
    ``get_text()`` re-extracts the same vertical token stream the parser expects.
    """
    document = fitz.open()
    page = document.new_page()
    y = 40.0
    for cell in _CELLS:
        page.insert_text((40, y), cell, fontsize=9)
        y += 14
    pdf = document.tobytes()
    document.close()
    return bytes(pdf)


class TestRealStatementDecode:
    """The unmocked parser reads a genuine rendered Galicia VISA statement PDF."""

    def test_parses_identity_period_and_total(self):
        """
        GIVEN a real rendered sanitized Galicia VISA statement PDF
        WHEN parsed through the unmocked PyMuPDF stack
        THEN the bank identity, period and total are extracted
        """
        parsed = parse_statement(_galicia_statement_pdf())

        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Galicia"
        assert parsed.network == "VISA"
        assert parsed.card_last4 == "5771"
        assert parsed.payment_method == "Galicia VISA ·5771"
        assert parsed.issuer_cuit == "30-50000173-5"
        assert parsed.statement_number == "VI00000000069436867"
        assert parsed.period_close == date(2026, 6, 11)
        assert parsed.period_due == date(2026, 6, 19)
        assert parsed.total_amount == Decimal("14521.66")

    def test_extracts_the_three_purchases_and_drops_the_netted_fee(self):
        """
        GIVEN the real rendered statement
        WHEN parsed
        THEN the three purchases are returned (skips/netting applied), summing to
             the consumo total
        """
        parsed = parse_statement(_galicia_statement_pdf())

        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert {line.name for line in purchases} == {
            "MERPAGO*PASSLINE",
            "Express Av Cordoba 3721",
            "SUBE VIAJES - BUSES",
        }
        assert sum(line.amount for line in purchases) == Decimal("14521.66")
        # The COM/BONI MANT pair nets to zero — no fee line.
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []
        # No payment / carryover row leaked in.
        assert not any("SU PAGO" in line.name.upper() for line in parsed.lines)
        assert not any("SALDO ANTERIOR" in line.name.upper() for line in parsed.lines)
