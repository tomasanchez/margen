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

from margen_api.domain.models.value_objects import Currency
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
        assert parsed.card == "VISA ·5771"  # card detail split from the bank (ADR-117).
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


# --------------------------------------------------------------------------- #
# SANITIZED Santander VISA statement (ADR-081). The real Santander get_text()      #
# PRESERVES the fixed-width layout with space padding: money right-aligns to stable #
# CHARACTER END columns (peso ends at 91, U$S at 110), pages joined by \n so each    #
# purchase stays its own line. Rendering each flat line as one monospace string      #
# round-trips those exact char columns through PyMuPDF get_text(), so the unmocked   #
# flat-text column parser sees the same geometry a real statement has. Guards the    #
# live bug end to end: a marker-less USD row (empty peso column + a decoy left of    #
# both columns + the amount in the U$S column), a missing-leading-dot total, the     #
# three taxes, and a phantom financing block that must never become fees.            #
# --------------------------------------------------------------------------- #

_PESO_END = 91
_USD_END = 110


def _flat_row(
    prefix: str,
    *,
    peso: str | None = None,
    usd: str | None = None,
    decoy: str | None = None,
    decoy_end: int = 65,
) -> str:
    """Place amounts right-aligned to their real END columns over a padded prefix."""
    line = list(prefix.ljust(120))

    def place(amount: str, end: int) -> None:
        start = end - len(amount)
        for i, char in enumerate(amount):
            line[start + i] = char

    if decoy is not None:
        place(decoy, decoy_end)
    if peso is not None:
        place(peso, _PESO_END)
    if usd is not None:
        place(usd, _USD_END)
    return "".join(line).rstrip()


def _santander_visa_lines() -> list[str]:
    """The synthetic Santander VISA flat lines — real char columns, fake data."""
    return [
        "Santander Rio",
        "VISA",
        "30 50000845 4",
        "N456",
        "CIERRE  26 Jun 26 VENCIMIENTO 26 Jul 26",
        _flat_row("                        SALDO ANTERIOR", peso="748.358,07", usd="0,00"),
        _flat_row("26 Junio   05           SU PAGO EN PESOS", peso="748.358,07-"),
        "________________________________________________________________________________",
        _flat_row("26 Mayo    10 007490 *  TIENDA UNO           C.02/06", peso="68.750,00"),
        _flat_row("           30 159049 K  TRANSPORTE LOCAL", peso="1.675,04"),
        _flat_row("26 Junio   01 444186    PROVEEDOR* GLOBAL ref9xUSD", usd="200,00", decoy="200,00"),
        _flat_row("           29 001125 K  COMERCIO CON NOMBRE MUY LARGO SA", peso="14.545,00"),
        _flat_row("Tarjeta 1041 Total Consumos de JUAN PEREZ", peso="1064.341,86", usd="200,00"),
        # BLANK line between the total and the first tax (real-statement quirk):
        # the fee section must SKIP it, not terminate on it.
        "",
        _flat_row("26 Julio   02           IMPUESTO DE SELLOS        $", peso="13.844,18"),
        _flat_row("           02           IMPUESTO DE SELLOS      P $", peso="3.573,60"),
        _flat_row("           02           DB.RG 5617  30% (", peso="89.340,00", decoy="297800,00", decoy_end=53),
        # BLANK line before the disclosure block (real-statement quirk): skipped too.
        "",
        _flat_row("                      3 cuotas de $ 379313,26 (TNA Fija:", decoy="379313,26", decoy_end=45),
        _flat_row("                Plan V: abonando el pago minimo de $", decoy="171660,00", decoy_end=67),
        "                SALDO ACTUAL                                                    1.114.759,64",
    ]


def _santander_visa_pdf() -> bytes:
    """Render the synthetic flat lines to a real PDF, one monospace string per line.

    A monospaced font makes PyMuPDF's ``get_text()`` reproduce the same fixed-width
    CHARACTER columns (peso end 91, U$S end 110) the flat-text column parser reads.
    """
    document = fitz.open()
    page = document.new_page()
    y = 40.0
    for line in _santander_visa_lines():
        page.insert_text((20, y), line, fontsize=8, fontname="courier")
        y += 12
    pdf = document.tobytes()
    document.close()
    return bytes(pdf)


class TestRealSantanderVisaUsdDecode:
    """The unmocked flat-text column parser reads a genuine rendered Santander PDF."""

    def test_parses_the_marker_less_usd_purchase_as_one_usd_line(self):
        """
        GIVEN a real rendered Santander VISA statement with a marker-less USD row
              (empty peso column, a decoy left of both columns, the amount in "U$S")
        WHEN parsed through the unmocked PyMuPDF stack (extract_text → parse)
        THEN it yields exactly one USD line with usd_amount=200 and no fabricated
             peso amount, decoy dropped from the name (ADR-079)
        """
        parsed = parse_statement(_santander_visa_pdf())

        assert parsed.status is ParseStatus.OK
        assert parsed.network == "VISA"
        assert parsed.total_amount == Decimal("1064341.86")  # missing-dot total tolerated.
        usd_lines = [line for line in parsed.lines if line.currency is Currency.USD]
        assert len(usd_lines) == 1
        assert usd_lines[0].usd_amount == Decimal("200.00")
        assert usd_lines[0].amount == Decimal("0")  # empty peso column → no fabricated pesos.
        assert "PROVEEDOR" in usd_lines[0].name
        assert "200,00" not in usd_lines[0].name  # the decoy reference is dropped.

    def test_captures_the_ars_purchases_and_the_three_taxes_with_no_phantoms(self):
        """
        GIVEN the real rendered statement
        WHEN parsed through the unmocked stack
        THEN the ARS purchases and exactly the three AR$ taxes are captured, and the
             cuotas / Plan V / SALDO ACTUAL block never leaks in as a phantom fee
        """
        parsed = parse_statement(_santander_visa_pdf())

        ars_amounts = {
            line.name: line.amount
            for line in parsed.lines
            if line.line_kind is LineKind.PURCHASE and line.currency is Currency.ARS
        }
        assert ars_amounts == {
            "TIENDA UNO": Decimal("68750.00"),
            "TRANSPORTE LOCAL": Decimal("1675.04"),
            "COMERCIO CON NOMBRE MUY LARGO SA": Decimal("14545.00"),
        }

        fees = {line.name: line.amount for line in parsed.lines if line.line_kind is LineKind.FEE}
        assert fees == {
            "IMPUESTO DE SELLOS": Decimal("13844.18"),
            "IMPUESTO DE SELLOS P": Decimal("3573.60"),
            "DB.RG 5617 30%": Decimal("89340.00"),
        }
        names = " ".join(line.name.upper() for line in parsed.lines)
        assert "CUOTAS" not in names
        assert "PLAN" not in names
        assert "SALDO" not in names


# --------------------------------------------------------------------------- #
# SANITIZED NEW-FORMAT Santander VISA statement (ADR-081). Santander redesigned    #
# its VISA resumen: PyMuPDF now emits a VERTICAL token stream (one cell per line)   #
# and it prints the DASHED CUIT (30-50000845-4), so the legacy flat-text            #
# Santander fingerprints (spaced CUIT) all missed it. Rendering each cell on its    #
# own line round-trips the same vertical stream the parser expects. All identifiers #
# and figures are fabricated (fake cardholder / statement number / last-4).         #
# The cells preserve the real quirks: the anterior/actual/próximo period pairs, a   #
# cuota row, the "Copia fiel …" + "N de 6" page footer that collides with a cuota   #
# shape, a USD "dolares" row, reprinted page-2 headers, the Pago-anterior block     #
# (skipped) and the Impuestos tax section (one FEE).                                #
# --------------------------------------------------------------------------- #
_NEW_VISA_CELLS: tuple[str, ...] = (
    "Resumen Visa",
    "N° 000000001",
    "Juan Perez",
    "CUIT: 30-50000845-4",
    "Total a pagar",
    "En pesos",
    " pesos 185.000,00",
    "En dólares",
    " dolares 50,00",
    "Período",
    "Cierre",
    "anterior",
    "30/06/26",
    "Vencimiento",
    "anterior",
    "07/07/26",
    "Cierre",
    "actual",
    "27/08/26",
    "Vencimiento",
    "actual",
    "04/09/26",
    "Próximo",
    "cierre",
    "01/10/26",
    "Próximo",
    "vencimiento",
    "09/10/26",
    "Copia fiel de carácter informativo",
    "1 de 6",
    # Pago anterior y devoluciones — payments, skipped (they precede the movimientos):
    "Pago anterior y devoluciones",
    "07/07/26",
    "Saldo anterior",
    " 1.000.000,00 pesos",
    "Su pago en pesos",
    " menos 1.000.000,00 pesos",
    # Movimientos — the date-grouped purchase rows:
    "Movimientos de Juan Perez",
    "Visa crédito terminada en 9999",
    "Fecha",
    "Descripción",
    "Cuota",
    "Comprobante",
    "Monto en pesos",
    "Monto en dólares",
    "10/05/26",
    "Tienda uno",
    "4 de 6",
    "007490",
    " 68.750,00 pesos",
    "31/07/26",
    "Merpago*coto",
    "162853",
    " 100.000,00 pesos",
    # page footer that collides with a cuota shape (M=6), dropped by position:
    "Copia fiel de carácter informativo",
    "2 de 6",
    # reprinted page-2 column header (dropped):
    "Fecha",
    "Descripción",
    "Cuota",
    "Comprobante",
    "Monto en pesos",
    "Monto en dólares",
    "01/08/26",
    "Apple store",
    "444186",
    " 50,00 dolares",
    "02/08/26",
    "Sube viajes - buses",
    "000270",
    " 250,00 pesos",
    "Subtotal de Juan Perez",
    " Subtotal en pesos. 169.000,00.",
    # Impuestos — the tax section (one FEE):
    "Impuestos, intereses y percepciones",
    "Fecha",
    "Descripción",
    "Monto en pesos",
    "Monto en dólares",
    "27/08/26",
    "Impuesto de sellos $",
    " 16.000,00 pesos",
    "Total a pagar",
    " Total en pesos. 185.000,00.",
)


def _new_visa_statement_pdf() -> bytes:
    """Render the sanitized new-format cells to a real multi-page PDF.

    One cell per line, breaking to a new page before the text runs off the bottom
    margin — the real statement is six pages, and pagination keeps every cell on
    the page (a single page would silently drop the cells past its height).
    """
    document = fitz.open()
    page = document.new_page()
    y = 40.0
    for cell in _NEW_VISA_CELLS:
        if y > 760.0:  # break to a new page before overflowing the bottom margin.
            page = document.new_page()
            y = 40.0
        page.insert_text((40, y), cell, fontsize=9)
        y += 11
    pdf = document.tobytes()
    document.close()
    return bytes(pdf)


class TestRealSantanderNewVisaDecode:
    """The unmocked parser reads a genuine rendered NEW-format Santander VISA PDF."""

    def test_parses_identity_period_and_total(self):
        """
        GIVEN a real rendered sanitized new-format Santander VISA statement PDF
        WHEN parsed through the unmocked PyMuPDF stack (extract_text → parse)
        THEN the bank identity, the CURRENT (actual) period and the total are read
        """
        parsed = parse_statement(_new_visa_statement_pdf())

        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Santander"
        assert parsed.network == "VISA"
        assert parsed.card_last4 == "9999"
        assert parsed.card == "VISA ·9999"  # card detail split from the bank (ADR-117).
        assert parsed.issuer_cuit == "30-50000845-4"
        assert parsed.statement_number == "000000001"
        assert parsed.period_close == date(2026, 8, 27)
        assert parsed.period_due == date(2026, 9, 4)
        assert parsed.total_amount == Decimal("185000.00")

    def test_extracts_the_purchases_the_usd_row_and_the_tax_clean(self):
        """
        GIVEN the real rendered new-format statement
        WHEN parsed
        THEN the four purchases (incl. the cuota + USD rows) and the one tax come
             back clean — no page-footer / header / cuota pollution — and reconcile
        """
        parsed = parse_statement(_new_visa_statement_pdf())

        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert {line.name for line in purchases} == {
            "Tienda uno",
            "Merpago*coto",
            "Apple store",
            "Sube viajes - buses",
        }
        # The installment row carries its cuota; the "2 de 6" page footer did not.
        tienda = next(line for line in purchases if line.name == "Tienda uno")
        assert tienda.cuota == "4 de 6"
        # The "dolares" row is a USD line with no fabricated peso amount.
        apple = next(line for line in purchases if line.name == "Apple store")
        assert apple.currency is Currency.USD
        assert apple.usd_amount == Decimal("50.00")
        assert apple.amount == Decimal("0")
        # The ARS purchases plus the one tax reconcile to the total.
        ars = sum(line.amount for line in purchases if line.currency is Currency.ARS)
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert ars == Decimal("169000.00")
        assert len(fees) == 1
        assert fees[0].name == "Impuesto de sellos"
        assert fees[0].amount == Decimal("16000.00")
        assert ars + fees[0].amount == parsed.total_amount
        # No payment / carryover row leaked in from the Pago-anterior block.
        assert not any("SALDO" in line.name.upper() for line in parsed.lines)
        assert not any("SU PAGO" in line.name.upper() for line in parsed.lines)


# --------------------------------------------------------------------------- #
# SANITIZED NEW-FORMAT Santander AMEX — a BYTE-FOR-BYTE twin of the VISA cells   #
# above, differing ONLY in the header title and the movimientos card-line marker #
# (and the last-4). Proves the SAME parser reads a rendered AMEX PDF as AMEX.     #
# --------------------------------------------------------------------------- #
_NEW_AMEX_CELLS: tuple[str, ...] = tuple(
    cell.replace("Resumen Visa", "Resumen American Express")
    .replace("Visa crédito terminada en 9999", "American Express crédito terminada en 3735")
    .replace(" en 9999 de Juan", " en 3735 de Juan")
    for cell in _NEW_VISA_CELLS
)


def _new_amex_statement_pdf() -> bytes:
    """Render the sanitized new-format AMEX twin cells to a real multi-page PDF."""
    document = fitz.open()
    page = document.new_page()
    y = 40.0
    for cell in _NEW_AMEX_CELLS:
        if y > 760.0:  # break to a new page before overflowing the bottom margin.
            page = document.new_page()
            y = 40.0
        page.insert_text((40, y), cell, fontsize=9)
        y += 11
    pdf = document.tobytes()
    document.close()
    return bytes(pdf)


class TestRealSantanderNewAmexDecode:
    """The unmocked parser reads a rendered NEW-format Santander AMEX PDF as AMEX."""

    def test_parses_identity_network_and_reconciles(self):
        """
        GIVEN a real rendered sanitized new-format Santander AMEX statement PDF
        WHEN parsed through the unmocked PyMuPDF stack (extract_text → parse)
        THEN the network is AMEX, the last-4 comes from the AMEX card-line, and the
             purchases plus the tax reconcile to the total — the same layout, network-aware
        """
        parsed = parse_statement(_new_amex_statement_pdf())

        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Santander"
        assert parsed.network == "AMEX"
        assert parsed.card_last4 == "3735"
        assert parsed.card == "AMEX ·3735"  # card detail split from the bank (ADR-117).
        assert parsed.total_amount == Decimal("185000.00")

        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert {line.name for line in purchases} == {
            "Tienda uno",
            "Merpago*coto",
            "Apple store",
            "Sube viajes - buses",
        }
        # The AMEX card-line marker never leaked into a purchase name.
        assert not any("EXPRESS" in line.name.upper() for line in purchases)
        ars = sum(line.amount for line in purchases if line.currency is Currency.ARS)
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert ars == Decimal("169000.00")
        assert len(fees) == 1
        assert ars + fees[0].amount == parsed.total_amount
