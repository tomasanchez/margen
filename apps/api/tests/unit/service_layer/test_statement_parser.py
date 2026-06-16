"""Unit tests for the pure Galicia VISA statement parser (ADR-076, ADR-079, ADR-082).

These exercise the parser's pure surface from plain strings, Decimals and dates —
no native PyMuPDF, no HTTP, no SQL (ADR-082). The native boundary (:func:`extract_text`)
is the *only* thing mocked, via ``monkeypatch``, so the fast-tier coverage gate
needs no native stack. The canonical fixture reproduces PyMuPDF's VERTICAL token
stream — one table cell per line — using SANITIZED Galicia VISA text (fake name,
address, account number; real structure) per ADR-081.

They prove: the full Galicia parse (metadata + purchase lines + skips + fee
netting), the Argentine decimal helper, the category guesser, both date formats,
cuota capture, USD line mapping, non-zero fee emission, the UNSUPPORTED and
UNPARSEABLE outcomes, and the ``parse_statement`` orchestration including the
parser-raises path.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer import statement_parser
from margen_api.service_layer.statement_parser import (
    BANK_PARSERS,
    GaliciaVisaParser,
    SantanderAmexParser,
    SantanderVisaParser,
    _parse_ar_decimal,
    _parse_d_mon_y,
    _parse_dmy,
    extract_text,
    extract_words,
    guess_category,
    parse_statement,
)
from margen_api.service_layer.statement_parser_read_models import (
    LineKind,
    ParsedStatement,
    ParseStatus,
)

# --------------------------------------------------------------------------- #
# Canonical SANITIZED Galicia VISA fixture (ADR-081). PyMuPDF emits one table  #
# cell per line — a vertical token stream — so the fixture is one cell per     #
# line, trailing spaces and blank lines preserved (they matter to the parser). #
# --------------------------------------------------------------------------- #

_GALICIA_VISA_TEXT = """\
  Resumen N° VI00000000069436867
 Tarjeta Crédito VISA
JUAN PEREZ
 Consumidor Final
CUIT Banco: 30-50000173-5
CALLE FALSA 123, CIUDAD AUTONOMA BUEN, C0000AAA
 N° Cuenta: 0000000000
Sucursal: 665
Resumen de tarjeta de credito VISA
20260611079436867H
Página
1 / 5
1.133.243,99
0,00
07-May-26
15-May-26
11-Jun-26
19-Jun-26
08-Jul-26
17-Jul-26
 CONSOLIDADO
PESOS
DÓLARES
SALDO ANTERIOR
612.544,09
0,00
15-05-26

SU PAGO EN PESOS
-612.544,09

DETALLE DEL CONSUMO
FECHA
REFERENCIA
CUOTA
COMPROBANTE
PESOS
DÓLARES
20-03-26
*
MERPAGO*PASSLINE
03/03
524072
3.641,66

08-05-26
K
Express Av Cordoba 3721
005306
10.180,00

14-05-26
K
SUBE VIAJES - BUSES
501892
700,00

TARJETA 5771 Total Consumos de JUAN PEREZ
14.521,66
0,00
11-06-26

COM MANT CTA Y RENO
25.206,00

11-06-26

BONI MANT CTA Y RENO
-25.206,00

TOTAL A PAGAR
14.521,66
0,00
"""


def _by_name(parsed: ParsedStatement, name: str):
    """Return the single parsed line whose ``name`` matches, or ``None``."""
    matches = [line for line in parsed.lines if line.name == name]
    return matches[0] if matches else None


class TestGaliciaVisaParserFullFixture:
    """The Galicia VISA parser reads the full sanitized statement end to end."""

    @pytest.fixture(name="parsed")
    def fixture_parsed(self) -> ParsedStatement:
        """Parse the canonical sanitized Galicia VISA text once for the class."""
        return GaliciaVisaParser().parse(_GALICIA_VISA_TEXT)

    def test_extracts_statement_metadata(self, parsed: ParsedStatement):
        """
        GIVEN the canonical sanitized Galicia VISA statement text
        WHEN it is parsed
        THEN every statement-level field is extracted with its expected value
        """
        # THEN
        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Galicia"
        assert parsed.network == "VISA"
        assert parsed.card_last4 == "5771"
        assert parsed.payment_method == "Galicia VISA ·5771"  # middot label.
        assert parsed.statement_number == "VI00000000069436867"
        assert parsed.issuer_cuit == "30-50000173-5"
        assert parsed.period_close == date(2026, 6, 11)
        assert parsed.period_due == date(2026, 6, 19)
        assert parsed.total_amount == Decimal("14521.66")

    def test_derives_the_natural_key(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN its natural key is read
        THEN it carries the issuer CUIT, card last-4 and statement number
        """
        # THEN
        assert parsed.natural_key is not None
        assert parsed.natural_key.issuer_cuit == "30-50000173-5"
        assert parsed.natural_key.card_last4 == "5771"
        assert parsed.natural_key.statement_number == "VI00000000069436867"

    def test_extracts_exactly_the_three_purchase_lines(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the purchase lines are read
        THEN exactly the three DETALLE DEL CONSUMO purchases are present (the
             payment and carryover rows are skipped, the netted fee is dropped)
        """
        # THEN
        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert len(purchases) == 3
        assert {line.name for line in purchases} == {
            "MERPAGO*PASSLINE",
            "Express Av Cordoba 3721",
            "SUBE VIAJES - BUSES",
        }

    def test_maps_the_first_purchase_with_cuota_and_category(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the MERPAGO purchase is read
        THEN its pay date (occurred_on), original FECHA (purchase_date), ARS amount,
             cuota marker and guessed category are mapped (ADR-089)
        """
        # THEN — occurred_on is the statement due date; purchase_date is the line's FECHA.
        line = _by_name(parsed, "MERPAGO*PASSLINE")
        assert line is not None
        assert line.occurred_on == date(2026, 6, 19)  # the fixture's due date (ADR-089).
        assert line.purchase_date == date(2026, 3, 20)  # the line's own FECHA.
        assert line.amount == Decimal("3641.66")
        assert line.currency is Currency.ARS
        assert line.cuota == "03/03"
        assert line.category == "Entertainment"
        assert line.line_kind is LineKind.PURCHASE

    def test_every_line_occurred_on_is_the_due_date(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement carrying a parseable due date
        WHEN each line's occurred_on is read
        THEN every line counts on the statement due date, decoupled from its FECHA (ADR-089)
        """
        # THEN — the due date is the 4th period token (19-Jun-26); every line shares it.
        assert parsed.period_due == date(2026, 6, 19)
        assert [line.occurred_on for line in parsed.lines] == [date(2026, 6, 19)] * len(parsed.lines)
        # AND — the per-line FECHA stays distinct from the shared pay date.
        express = _by_name(parsed, "Express Av Cordoba 3721")
        assert express is not None
        assert express.purchase_date == date(2026, 5, 8)
        sube = _by_name(parsed, "SUBE VIAJES - BUSES")
        assert sube is not None
        assert sube.purchase_date == date(2026, 5, 14)

    def test_maps_the_food_and_transport_purchases(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the Express and SUBE purchases are read
        THEN their amounts and guessed categories are mapped, with no cuota
        """
        # THEN
        express = _by_name(parsed, "Express Av Cordoba 3721")
        assert express is not None
        assert express.amount == Decimal("10180.00")
        assert express.category == "Food"
        assert express.cuota is None

        sube = _by_name(parsed, "SUBE VIAJES - BUSES")
        assert sube is not None
        assert sube.amount == Decimal("700.00")
        assert sube.category == "Transport"

    def test_skips_payment_and_carryover_rows(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the lines are scanned for payment / carryover labels
        THEN no SU PAGO or SALDO ANTERIOR row became a line (ADR-079)
        """
        # THEN — recording these would double-count.
        names = [line.name for line in parsed.lines]
        assert not any("SU PAGO" in name.upper() for name in names)
        assert not any("SALDO ANTERIOR" in name.upper() for name in names)

    def test_nets_the_fully_waived_fee_to_zero(self, parsed: ParsedStatement):
        """
        GIVEN the COM MANT charge and its matching BONI MANT waiver
        WHEN the statement is parsed
        THEN the pair nets to zero and produces no FEE line
        """
        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []


class TestParseArDecimal:
    """_parse_ar_decimal parses the Argentine money format (thousands '.' decimal ',')."""

    @pytest.mark.parametrize(
        ("token", "expected"),
        [
            ("1.133.243,99", Decimal("1133243.99")),
            ("612.544,09", Decimal("612544.09")),
            ("700,00", Decimal("700.00")),
            ("-25.206,00", Decimal("-25206.00")),  # leading sign preserved for waivers.
            ("  3.641,66  ", Decimal("3641.66")),  # surrounding whitespace tolerated.
        ],
    )
    def test_parses_valid_money_tokens(self, token: str, expected: Decimal):
        """
        GIVEN an Argentine-formatted money token (possibly signed / padded)
        WHEN it is parsed
        THEN the Decimal value is returned with the sign preserved
        """
        assert _parse_ar_decimal(token) == expected

    @pytest.mark.parametrize("token", ["", "  ", "n/a", "abc", "DÓLARES"])
    def test_non_numeric_tokens_return_none(self, token: str):
        """
        GIVEN a non-numeric token
        WHEN it is parsed
        THEN None is returned (no exception escapes)
        """
        assert _parse_ar_decimal(token) is None


class TestGuessCategory:
    """guess_category maps merchant keywords to a category, else None."""

    @pytest.mark.parametrize(
        ("merchant", "expected"),
        [
            ("MERPAGO*PASSLINE", "Entertainment"),
            ("PASSLINE TICKETS", "Entertainment"),
            ("GIESSO Local", "Shopping"),
            ("CARDON", "Shopping"),
            ("EQUUS", "Shopping"),
            ("ROCHAS", "Shopping"),
            ("VINIAURBANA", "Shopping"),
            ("Vinia Urbana", "Shopping"),
            ("SUBE VIAJES - BUSES", "Transport"),
            ("SUSHI CLUB", "Food"),
            ("Express Av Cordoba 3721", "Food"),
        ],
    )
    def test_maps_each_known_keyword(self, merchant: str, expected: str):
        """
        GIVEN a merchant string containing a mapped keyword (any case)
        WHEN its category is guessed
        THEN the mapped category is returned
        """
        assert guess_category(merchant) == expected

    def test_unknown_merchant_returns_none(self):
        """
        GIVEN a merchant string with no mapped keyword
        WHEN its category is guessed
        THEN None is returned (the review UI fills it in)
        """
        assert guess_category("Kiosco de la esquina") is None


class TestDateAndCuotaParsing:
    """The parser reads both DD-MM-YY purchase dates and the dd-Mon-yy period run."""

    def test_parses_dd_mm_yy_purchase_date(self):
        """
        GIVEN a statement whose purchase row carries a DD-MM-YY date cell
        WHEN it is parsed
        THEN the purchase date is read as a 20YY date on purchase_date (ADR-089)
        """
        # GIVEN — a minimal detail section with one purchase.
        text = _minimal_detail(["08-05-26", "K", "Some Shop ", "001", "1.000,00", " "])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — the FECHA is read onto purchase_date.
        assert parsed.lines[0].purchase_date == date(2026, 5, 8)

    def test_parses_dd_mon_yy_period_close_and_due(self):
        """
        GIVEN the six dd-Mon-yy header tokens
        WHEN the statement is parsed
        THEN the 3rd token is the close date and the 4th is the due date
        """
        # WHEN
        parsed = GaliciaVisaParser().parse(_GALICIA_VISA_TEXT)

        # THEN — the run is 07-May 15-May 11-Jun 19-Jun 08-Jul 17-Jul.
        assert parsed.period_close == date(2026, 6, 11)
        assert parsed.period_due == date(2026, 6, 19)

    def test_missing_period_run_leaves_dates_none(self):
        """
        GIVEN a statement text with no six-token dd-Mon-yy run
        WHEN it is parsed
        THEN both period dates are None (parsed defensively)
        """
        # GIVEN — a detail-only fixture, no header period block.
        text = _minimal_detail(["08-05-26", "Shop ", "001", "1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.period_close is None
        assert parsed.period_due is None


class TestNoneDueDateFallback:
    """When the statement carries no parseable due date, occurred_on falls back to FECHA (ADR-089)."""

    def test_purchase_line_falls_back_to_its_own_purchase_date(self):
        """
        GIVEN a fingerprinting Galicia text WITHOUT the six-token period run
        WHEN it is parsed (so period_due is None)
        THEN the purchase line's occurred_on falls back to its own FECHA, equal to
             purchase_date (the None-pay-date branch — ADR-089)
        """
        # GIVEN — _minimal_detail carries no header period block, so period_due is None.
        text = _minimal_detail(["08-05-26", "K", "Some Shop ", "001", "1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — no due date parsed, so occurred_on == purchase_date for the line.
        assert parsed.period_due is None
        line = parsed.lines[0]
        assert line.purchase_date == date(2026, 5, 8)
        assert line.occurred_on == date(2026, 5, 8)
        assert line.occurred_on == line.purchase_date

    def test_fee_line_falls_back_to_its_own_row_date(self):
        """
        GIVEN a Galicia text WITHOUT the six-token period run carrying an un-waived fee
        WHEN it is parsed (so period_due is None)
        THEN the emitted FEE line's occurred_on falls back to that fee row's own date
             (the None-pay-date fee branch — ADR-089)
        """
        # GIVEN — a fingerprinting fee section with no header period block.
        text = "\n".join(
            [
                "Tarjeta Crédito VISA",
                "CUIT Banco: 30-50000173-5",
                "Resumen N° VI123",
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "COM MANT CTA Y RENO ",
                "25.206,00",
                "TOTAL A PAGAR",
                "26.206,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — no due date, so the fee's occurred_on falls back to its own row date.
        assert parsed.period_due is None
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].occurred_on == date(2026, 6, 11)
        assert fees[0].purchase_date == date(2026, 6, 11)


class TestUsdLineMapping:
    """A purchase carrying a DÓLARES money cell maps to a USD line (ADR-079)."""

    def test_second_money_cell_yields_a_usd_line(self):
        """
        GIVEN a purchase row with both a PESOS and a DÓLARES money cell
        WHEN it is parsed
        THEN currency is USD, usd_amount is the second cell, and fx is left None
        """
        # GIVEN — date / marker / merchant / comprobante / pesos / dolares.
        text = _minimal_detail(["10-05-26", "*", "Apple Store ", "004455", "120.000,00", "100,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        line = parsed.lines[0]
        assert line.currency is Currency.USD
        assert line.amount == Decimal("120000.00")
        assert line.usd_amount == Decimal("100.00")
        assert line.fx_rate is None
        assert line.fx_rate_type is None


class TestFeeEmission:
    """An un-waived fee emits one positive FEE line (ADR-079)."""

    def test_non_zero_net_fee_emits_one_fee_line(self):
        """
        GIVEN a COM MANT charge with NO matching BONI waiver
        WHEN the statement is parsed
        THEN one FEE line is emitted with the full charge amount
        """
        # GIVEN — a fee section with only the charge, between the consumo total and
        # the grand total.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                " ",
                "COM MANT CTA Y RENO ",
                "25.206,00",
                " ",
                "TOTAL A PAGAR",
                "26.206,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].name == "COM MANT CTA Y RENO"
        assert fees[0].amount == Decimal("25206.00")
        assert fees[0].occurred_on == date(2026, 6, 11)
        assert fees[0].category is None

    def test_fee_amount_after_an_intervening_cell_is_found(self):
        """
        GIVEN a fee label separated from its amount by an extra non-money cell
        WHEN the statement is parsed
        THEN the lookahead skips the intervening cell and still finds the amount
        """
        # GIVEN — an INT FINANCIACION fee whose amount is preceded by a stray cell
        # (exercises the money lookahead stepping over a non-money, non-date cell).
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "INT FINANCIACION ",
                "ref-extra ",
                "1.000,00",
                "TOTAL A PAGAR",
                "2.000,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].name == "INT FINANCIACION"
        assert fees[0].amount == Decimal("1000.00")

    def test_fee_row_without_a_money_cell_is_skipped(self):
        """
        GIVEN a fee label with no money cell before the next date / total
        WHEN the statement is parsed
        THEN no fee line is emitted (the lookahead finds no amount)
        """
        # GIVEN — a COM label with no amount before TOTAL A PAGAR.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "COM MANT CTA Y RENO ",
                "TOTAL A PAGAR",
                "1.000,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []

    def test_date_followed_by_a_non_fee_label_is_skipped(self):
        """
        GIVEN a dated row in the fee region whose next cell is not a fee label
        WHEN the statement is parsed
        THEN it is not treated as a fee (the fee-label guard rejects it)
        """
        # GIVEN — a stray dated row carrying a plain label in the fee region.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "Random note row ",
                "9.999,00",
                "TOTAL A PAGAR",
                "1.000,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []


class TestPurchaseRowGuards:
    """Defensive guards on building a purchase row from grouped cells."""

    def test_stray_cell_before_the_first_date_is_ignored(self):
        """
        GIVEN a detail section whose first cell is not a date (a stray cell)
        WHEN the statement is parsed
        THEN the stray cell is ignored and the following dated row still parses
        """
        # GIVEN — a non-date, non-noise cell precedes the first dated row (exercises
        # the row grouper seeing a cell while no row has started).
        text = _minimal_detail(["Stray opening cell ", "08-05-26", "K", "Shop ", "000123", "1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — the stray cell did not start or join a row; the purchase is intact.
        assert parsed.status is ParseStatus.OK
        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert len(purchases) == 1
        assert purchases[0].name == "Shop"
        assert purchases[0].amount == Decimal("1000.00")

    def test_row_without_a_money_cell_is_dropped(self):
        """
        GIVEN a detail row with a date but no money cell
        WHEN the statement is parsed
        THEN the row produces no purchase line
        """
        # GIVEN
        text = _minimal_detail(["08-05-26", "K", "Shop with no amount ", "001"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.status is ParseStatus.UNPARSEABLE
        assert parsed.lines == []

    def test_row_with_an_impossible_date_is_dropped(self):
        """
        GIVEN a detail row whose date cell matches the shape but is not a real date
        WHEN the statement is parsed
        THEN the row produces no purchase line (the date guard rejects it)
        """
        # GIVEN — "99-99-99" matches the DD-MM-YY cell regex but is no calendar date.
        text = _minimal_detail(["99-99-99", "K", "Shop ", "001", "1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.lines == []

    def test_skip_label_inside_the_detail_section_is_dropped(self):
        """
        GIVEN a SU PAGO row that lands inside the detail section
        WHEN the statement is parsed
        THEN the defensive skip guard drops it (it must never become a transaction)
        """
        # GIVEN — a payment row carrying the SU PAGO marker with a money cell.
        text = _minimal_detail(["15-05-26", "SU PAGO EN PESOS ", "001", "-1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.lines == []

    def test_row_with_only_structured_cells_has_no_name_and_is_dropped(self):
        """
        GIVEN a detail row whose only non-money cells are structured (comprobante)
        WHEN the statement is parsed
        THEN the empty merchant name drops the row
        """
        # GIVEN — date / marker / comprobante / money, no merchant text.
        text = _minimal_detail(["08-05-26", "*", "001234", "1.000,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.lines == []


class TestUnsupportedAndUnparseable:
    """The parser distinguishes an unsupported issuer from an unparseable match."""

    def test_unsupported_issuer_does_not_fingerprint(self):
        """
        GIVEN text lacking the Galicia / VISA fingerprint markers
        WHEN parse_statement runs (text monkeypatched)
        THEN it returns UNSUPPORTED with no lines (a calm fallback — ADR-080)
        """
        # GIVEN — neither Galicia/CUIT nor VISA present.
        assert GaliciaVisaParser().fingerprint("Some other bank Mastercard statement") is False

    def test_matched_but_empty_detail_yields_unparseable(self):
        """
        GIVEN a Galicia VISA fingerprint but no extractable detail lines
        WHEN the statement is parsed
        THEN the status is UNPARSEABLE (matched, nothing extracted)
        """
        # GIVEN — fingerprint markers but no DETALLE section.
        text = "Tarjeta Crédito VISA\nCUIT Banco: 30-50000173-5\nResumen N° VI123\n"

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert parsed.status is ParseStatus.UNPARSEABLE
        assert parsed.lines == []

    def test_fingerprint_matches_on_galicia_word_alone(self):
        """
        GIVEN text carrying the 'galicia' word and VISA but not the CUIT
        WHEN the fingerprint runs
        THEN it still matches (either marker satisfies the issuer half)
        """
        assert GaliciaVisaParser().fingerprint("Banco Galicia tarjeta VISA") is True


class TestParseStatementOrchestration:
    """parse_statement wires the native text extraction to the registry (ADR-076)."""

    def test_matching_text_runs_the_galicia_parser(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN extracted text that fingerprints as Galicia VISA
        WHEN parse_statement runs (extract_text monkeypatched)
        THEN it returns the Galicia parser's OK result
        """
        # GIVEN
        monkeypatch.setattr(statement_parser, "extract_text", lambda _pdf: _GALICIA_VISA_TEXT)

        # WHEN
        parsed = parse_statement(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Galicia"
        assert len(parsed.lines) == 3

    def test_no_matching_parser_yields_unsupported(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN extracted text no registered parser fingerprints
        WHEN parse_statement runs
        THEN it returns UNSUPPORTED carrying the extracted text (a calm result)
        """
        # GIVEN
        monkeypatch.setattr(statement_parser, "extract_text", lambda _pdf: "unknown bank statement")

        # WHEN
        parsed = parse_statement(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.UNSUPPORTED
        assert parsed.extracted_text == "unknown bank statement"
        assert parsed.lines == []

    def test_parser_that_raises_yields_unparseable(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a matched parser whose parse() raises
        WHEN parse_statement runs
        THEN the exception is swallowed into a calm UNPARSEABLE result, not propagated
        """

        # GIVEN — a parser that always matches and always raises.
        class _BoomParser(statement_parser.StatementParser):
            def fingerprint(self, text: str) -> bool:
                return True

            def parse(self, text: str) -> ParsedStatement:
                raise RuntimeError("boom")

        monkeypatch.setattr(statement_parser, "extract_text", lambda _pdf: "anything")
        monkeypatch.setattr(statement_parser, "BANK_PARSERS", [_BoomParser()])

        # WHEN
        parsed = parse_statement(b"%PDF-fake")

        # THEN
        assert parsed.status is ParseStatus.UNPARSEABLE
        assert parsed.extracted_text == "anything"


class TestDateHelpers:
    """The pure date helpers parse the two statement formats defensively."""

    def test_parse_dmy_reads_a_two_digit_year_as_20yy(self):
        """GIVEN a DD-MM-YY token WHEN parsed THEN the year resolves to 20YY."""
        assert _parse_dmy("20-03-26") == date(2026, 3, 20)

    def test_parse_dmy_malformed_token_returns_none(self):
        """GIVEN a token that is not DD-MM-YY WHEN parsed THEN None comes back."""
        assert _parse_dmy("2026-03-20") is None

    def test_parse_dmy_impossible_calendar_date_returns_none(self):
        """
        GIVEN a token matching the shape but naming an impossible date
        WHEN parsed
        THEN the ValueError is swallowed into None
        """
        assert _parse_dmy("99-99-99") is None

    def test_parse_d_mon_y_reads_a_spanish_month(self):
        """GIVEN a DD-Mon-YY token WHEN parsed THEN the Spanish month maps right."""
        assert _parse_d_mon_y("11-Jun-26") == date(2026, 6, 11)

    def test_parse_d_mon_y_malformed_token_returns_none(self):
        """GIVEN a token that is not DD-Mon-YY WHEN parsed THEN None comes back."""
        assert _parse_d_mon_y("11/06/26") is None

    def test_parse_d_mon_y_unknown_month_returns_none(self):
        """GIVEN a token with an unknown month abbreviation WHEN parsed THEN None."""
        assert _parse_d_mon_y("11-Zzz-26") is None

    def test_parse_d_mon_y_impossible_calendar_date_returns_none(self):
        """GIVEN a DD-Mon-YY token naming an impossible day WHEN parsed THEN None."""
        assert _parse_d_mon_y("99-Jun-26") is None


class TestFeeRootAndLookaheads:
    """The fee-netting lookaheads and label-root normalisation (ADR-079)."""

    def test_non_com_boni_fee_keeps_its_full_root(self):
        """
        GIVEN an interest fee label that is not a COM/BONI pair
        WHEN the statement is parsed
        THEN it emits a FEE line under its own (un-stripped) root
        """
        # GIVEN — an "INT " label that _looks_like_fee accepts but _fee_root keeps whole.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "INT FINANCIACION ",
                "500,00",
                "TOTAL A PAGAR",
                "1.500,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].name == "INT FINANCIACION"
        assert fees[0].amount == Decimal("500.00")

    def test_fee_date_with_a_following_date_before_money_is_skipped(self):
        """
        GIVEN a fee label followed by another date cell before any money
        WHEN the statement is parsed
        THEN the money lookahead stops at the date and emits no fee line
        """
        # GIVEN — COM label, then a new date arrives before any amount.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                "COM MANT CTA Y RENO ",
                "12-06-26",
                "100,00",
                "TOTAL A PAGAR",
                "1.000,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — the first COM has no money before the next date, so nothing nets.
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []

    def test_fee_date_with_only_noise_after_emits_nothing(self):
        """
        GIVEN a dated cell in the fee region followed only by page-chrome noise
        WHEN the statement is parsed
        THEN the meaningful-cell lookahead returns nothing and no fee is emitted
        """
        # GIVEN — a trailing date with only blank / chrome cells before the total.
        text = "\n".join(
            [
                "DETALLE DEL CONSUMO  ",
                "08-05-26",
                "Shop ",
                "001",
                "1.000,00",
                "TARJETA 5771 Total Consumos de JUAN PEREZ ",
                "1.000,00",
                "11-06-26",
                " ",
                "PÁGINA",
                "TOTAL A PAGAR",
                "1.000,00",
            ]
        )

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []


class TestRowGroupingNoise:
    """Page chrome inside a section is dropped while grouping rows."""

    def test_noise_cell_inside_a_purchase_row_is_dropped(self):
        """
        GIVEN a purchase row split by a reprinted page-header chrome cell
        WHEN the statement is parsed
        THEN the chrome cell is dropped and the merchant name stays clean
        """
        # GIVEN — a "PÁGINA" chrome cell lands between the merchant and the amount.
        text = _minimal_detail(["08-05-26", "K", "Express Av Cordoba 3721 ", "PÁGINA", "005306", "10.180,00"])

        # WHEN
        parsed = GaliciaVisaParser().parse(text)

        # THEN — the row survives and the chrome did not pollute the name.
        line = parsed.lines[0]
        assert line.name == "Express Av Cordoba 3721"
        assert line.amount == Decimal("10180.00")


class TestNativeBoundary:
    """The native-isolated functions, exercised with PyMuPDF (``fitz``) mocked.

    ADR-082 keeps PyMuPDF out of the fast tier; the real text extraction is proven
    only in the integration tier. ``fitz`` is imported lazily inside the boundary
    functions (ADR-076), so these inject a fake ``fitz`` into ``sys.modules`` for
    the local ``import fitz`` to resolve — no native library needed.
    """

    def test_extract_text_concatenates_page_text(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a two-page PDF (fitz mocked)
        WHEN the text is extracted
        THEN the page texts are concatenated newline-separated
        """
        # GIVEN
        pages = [_FakePage("page one"), _FakePage("page two")]
        monkeypatch.setitem(sys.modules, "fitz", SimpleNamespace(open=_fake_fitz_open(pages)))

        # WHEN / THEN
        assert extract_text(b"%PDF-fake") == "page one\npage two"

    def test_extract_words_flattens_word_tuples_across_pages(self, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a two-page PDF whose pages each yield word tuples (fitz mocked)
        WHEN the words are extracted
        THEN every page's word tuples are returned in one flat list
        """
        # GIVEN
        page_one = [(0.0, 0.0, 10.0, 9.0, "alpha", 0, 0, 0)]
        page_two = [(0.0, 0.0, 10.0, 9.0, "beta", 0, 0, 0)]
        pages = [_FakePage("p1", page_one), _FakePage("p2", page_two)]
        monkeypatch.setitem(sys.modules, "fitz", SimpleNamespace(open=_fake_fitz_open(pages)))

        # WHEN / THEN
        assert extract_words(b"%PDF-fake") == [*page_one, *page_two]


class TestRegistry:
    """The bank parser registry is the additive extension point (ADR-076)."""

    def test_registry_contains_the_galicia_parser(self):
        """
        GIVEN the module-level BANK_PARSERS registry
        WHEN it is inspected
        THEN it carries a GaliciaVisaParser instance
        """
        assert any(isinstance(parser, GaliciaVisaParser) for parser in BANK_PARSERS)


class _FakePage:
    """A stand-in PyMuPDF page exposing the text and words the boundary reads."""

    def __init__(self, text: str, words: list[tuple] | None = None) -> None:
        self._text = text
        self._words = words or []

    def get_text(self, kind: str = "text") -> str | list[tuple]:
        """Return the canned text, or the words when asked for ``"words"``."""
        if kind == "words":
            return self._words
        return self._text


def _fake_fitz_open(pages: list[_FakePage]):
    """Build a ``fitz.open`` replacement yielding a context-managed document."""

    @contextmanager
    def _open(*, stream: bytes, filetype: str):
        del stream, filetype
        yield pages

    return _open


# --------------------------------------------------------------------------- #
# SANITIZED Santander fixtures (ADR-081). The Santander layout is a fixed-width #
# columnar text stream (not Galicia's one-cell-per-line), so each transaction   #
# is a single flat line. The ``___`` separator opens the purchase section and   #
# ``Tarjeta NNNN Total Consumos`` closes it; fee rows follow that marker.        #
# --------------------------------------------------------------------------- #

_SANTANDER_AMEX_TEXT = """\
N319
30 50000845 4
AMERICAN  EXPRESS
CIERRE 28 May 26
VENCIMIENTO 10 Jun 26
____________________________
15 Mayo 1 1234 * 648640*MERCADO LIBRE C.01/12 1.000,00
10 Mayo 2 5678 * APPLE STORE 2.000,00 100,00
Tarjeta 5678 Total Consumos 3.000,00
10 Jun 26 IMPUESTO SELLOS $ 500,00
"""

_SANTANDER_VISA_TEXT = """\
N456
30 50000845 4
VISA
CIERRE 15 May 26
VENCIMIENTO 01 Jun 26
____________________________
15 Mayo 1 1234 * SUSHI CLUB 1.500,00
Tarjeta 5678 Total Consumos 1.500,00
"""


def _santander_amex_detail(cells: list[str]) -> str:
    """Build a minimal fingerprinting Santander AMEX text wrapping the given lines.

    The fingerprint markers (issuer CUIT + double-space AMEX header) and the
    ``___`` purchase-section opener precede the supplied transaction lines, with a
    CIERRE/VENCIMIENTO header so a period year and pay date are available. A
    ``Tarjeta NNNN Total Consumos`` terminator closes the section after the lines.
    """
    return "\n".join(
        [
            "N319",
            "30 50000845 4",
            "AMERICAN  EXPRESS",
            "CIERRE 28 May 26",
            "VENCIMIENTO 10 Jun 26",
            "____________________________",
            *cells,
            "Tarjeta 5678 Total Consumos 3.000,00",
        ]
    )


class TestSantanderAmexParserFullFixture:
    """The Santander AMEX parser reads the full sanitized statement end to end."""

    @pytest.fixture(name="parsed")
    def fixture_parsed(self) -> ParsedStatement:
        """Parse the canonical sanitized Santander AMEX text once for the class."""
        return SantanderAmexParser().parse(_SANTANDER_AMEX_TEXT)

    def test_extracts_statement_metadata(self, parsed: ParsedStatement):
        """
        GIVEN the canonical sanitized Santander AMEX statement text
        WHEN it is parsed
        THEN every statement-level field is extracted with its expected value
        """
        # THEN
        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Santander"
        assert parsed.network == "AMEX"
        assert parsed.card_last4 == "5678"
        assert parsed.payment_method == "Santander AMEX ·5678"  # middot label.
        assert parsed.statement_number == "N319"
        assert parsed.issuer_cuit == "30-50000845-4"
        assert parsed.period_close == date(2026, 5, 28)
        assert parsed.period_due == date(2026, 6, 10)
        assert parsed.total_amount == Decimal("3000.00")

    def test_derives_the_natural_key(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN its natural key is read
        THEN it carries the issuer CUIT, card last-4 and statement number
        """
        # THEN
        assert parsed.natural_key is not None
        assert parsed.natural_key.issuer_cuit == "30-50000845-4"
        assert parsed.natural_key.card_last4 == "5678"
        assert parsed.natural_key.statement_number == "N319"

    def test_extracts_the_two_purchase_lines(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the purchase lines are read
        THEN exactly the two transaction rows are present (the fee row is a FEE,
             not a PURCHASE)
        """
        # THEN
        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert len(purchases) == 2
        assert {line.name for line in purchases} == {"MERCADO LIBRE", "APPLE STORE"}

    def test_maps_the_first_purchase_with_cuota_and_cleaned_name(self, parsed: ParsedStatement):
        """
        GIVEN the parsed statement
        WHEN the MERCADO LIBRE purchase is read
        THEN its leading reference code is stripped, the cuota is captured, the pay
             date (occurred_on) is the due date and the purchase_date is its own date
        """
        # THEN — "648640*MERCADO LIBRE" cleaned to "MERCADO LIBRE"; cuota "01/12".
        line = _by_name(parsed, "MERCADO LIBRE")
        assert line is not None
        assert line.occurred_on == date(2026, 6, 10)  # the statement due date (ADR-089).
        assert line.purchase_date == date(2026, 5, 15)  # the line's own date.
        assert line.amount == Decimal("1000.00")
        assert line.currency is Currency.ARS
        assert line.cuota == "01/12"
        assert line.line_kind is LineKind.PURCHASE

    def test_maps_the_usd_purchase_line(self, parsed: ParsedStatement):
        """
        GIVEN a purchase row carrying both an ARS and a USD amount
        WHEN it is parsed
        THEN currency is USD, amount is the ARS column and usd_amount the USD column
        """
        # THEN
        line = _by_name(parsed, "APPLE STORE")
        assert line is not None
        assert line.currency is Currency.USD
        assert line.amount == Decimal("2000.00")
        assert line.usd_amount == Decimal("100.00")
        assert line.fx_rate is None
        assert line.fx_rate_type is None

    def test_maps_the_fee_line(self, parsed: ParsedStatement):
        """
        GIVEN the post-total IMPUESTO SELLOS fee row
        WHEN the statement is parsed
        THEN one FEE line is emitted with its name, amount and pay date
        """
        # THEN
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].name == "IMPUESTO SELLOS"
        assert fees[0].amount == Decimal("500.00")
        assert fees[0].occurred_on == date(2026, 6, 10)
        assert fees[0].purchase_date == date(2026, 6, 10)
        assert fees[0].currency is Currency.ARS
        assert fees[0].category is None


class TestSantanderVisaParser:
    """The Santander VISA parser shares the base layout but reports VISA branding."""

    @pytest.fixture(name="parsed")
    def fixture_parsed(self) -> ParsedStatement:
        """Parse the minimal sanitized Santander VISA text once for the class."""
        return SantanderVisaParser().parse(_SANTANDER_VISA_TEXT)

    def test_reports_visa_network_and_payment_method(self, parsed: ParsedStatement):
        """
        GIVEN a Santander VISA statement
        WHEN it is parsed
        THEN the network is VISA and the payment method uses the VISA prefix
        """
        # THEN
        assert parsed.status is ParseStatus.OK
        assert parsed.bank_name == "Santander"
        assert parsed.network == "VISA"
        assert parsed.payment_method == "Santander VISA ·5678"
        assert parsed.statement_number == "N456"
        assert parsed.period_close == date(2026, 5, 15)
        assert parsed.period_due == date(2026, 6, 1)

    def test_parses_its_single_purchase(self, parsed: ParsedStatement):
        """
        GIVEN the VISA statement's one transaction row
        WHEN it is parsed
        THEN the purchase is mapped with its category guessed
        """
        # THEN
        line = _by_name(parsed, "SUSHI CLUB")
        assert line is not None
        assert line.amount == Decimal("1500.00")
        assert line.category == "Food"
        assert line.line_kind is LineKind.PURCHASE

    def test_visa_fingerprint_rejects_amex_text(self):
        """
        GIVEN the AMEX fixture (which mentions VISA only in legal text)
        WHEN the VISA fingerprint runs
        THEN it does NOT match (the double-space AMEX header excludes it)
        """
        # THEN
        assert SantanderVisaParser().fingerprint(_SANTANDER_AMEX_TEXT) is False


class TestSantanderExtractPeriodDate:
    """_extract_period_date parses a DD MonAbb YY header date defensively."""

    def test_no_match_returns_none(self):
        """GIVEN text with no CIERRE token WHEN parsed THEN None comes back."""
        assert SantanderAmexParser._extract_period_date(SantanderAmexParser._CIERRE_RE, "no header here") is None

    def test_unknown_month_returns_none(self):
        """
        GIVEN a CIERRE date with an unknown month abbreviation
        WHEN parsed
        THEN None comes back (the month map lookup fails)
        """
        assert SantanderAmexParser._extract_period_date(SantanderAmexParser._CIERRE_RE, "CIERRE 28 Zzz 26") is None

    def test_impossible_calendar_date_returns_none(self):
        """
        GIVEN a CIERRE date naming an impossible day
        WHEN parsed
        THEN the ValueError is swallowed into None
        """
        assert SantanderAmexParser._extract_period_date(SantanderAmexParser._CIERRE_RE, "CIERRE 32 May 26") is None


class TestSantanderPurchaseEdgeCases:
    """Defensive branches in the Santander purchase row parser."""

    def test_dateless_line_with_no_pay_date_is_skipped(self):
        """
        GIVEN a transaction line with no DD MonthName prefix and a statement with
              no VENCIMIENTO (so pay_date is None)
        WHEN it is parsed
        THEN the line is skipped (occurred_on and purchase_date are both None)
        """
        # GIVEN — no VENCIMIENTO header so pay_date is None, and the line omits its
        # own date prefix, so the row has no date at all.
        text = "\n".join(
            [
                "N319",
                "30 50000845 4",
                "AMERICAN  EXPRESS",
                "____________________________",
                "1 1234 * SOME SHOP 1.000,00",
                "Tarjeta 5678 Total Consumos 1.000,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — the guard drops the dateless, pay-date-less line.
        assert parsed.period_due is None
        assert [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE] == []

    def test_impossible_date_prefix_falls_back_to_pay_date(self):
        """
        GIVEN a transaction whose date prefix names an impossible day
        WHEN it is parsed
        THEN the purchase_date falls back to the statement pay date
        """
        # GIVEN — "32 Mayo" is no calendar date; pay date is the VENCIMIENTO.
        text = _santander_amex_detail(["32 Mayo 1 1234 * SOME SHOP 1.000,00"])

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — the construction ValueError makes purchase_date fall back to pay date.
        line = _by_name(parsed, "SOME SHOP")
        assert line is not None
        assert line.purchase_date == date(2026, 6, 10)
        assert line.occurred_on == date(2026, 6, 10)

    def test_unknown_month_uses_current_month_fallback(self):
        """
        GIVEN a transaction whose date prefix names an unknown month
        WHEN it is parsed
        THEN current_month is unchanged (defaults to 1) and the date still builds
        """
        # GIVEN — "15 Zzz" has an unknown month, so current_month stays None → 1.
        text = _santander_amex_detail(["15 Zzz 1 1234 * SOME SHOP 1.000,00"])

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — month falls back to January of the period year.
        line = _by_name(parsed, "SOME SHOP")
        assert line is not None
        assert line.purchase_date == date(2026, 1, 15)

    def test_non_matching_line_in_section_is_ignored(self):
        """
        GIVEN a junk line inside the purchase section that matches no TX shape
        WHEN it is parsed
        THEN it is skipped and the following real purchase still parses
        """
        # GIVEN — a free-text line that does not match _TX_LINE precedes the real row.
        text = _santander_amex_detail(
            [
                "this line is not a transaction at all",
                "15 Mayo 1 1234 * SOME SHOP 1.000,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — the junk line is ignored; the real purchase survives.
        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert len(purchases) == 1
        assert purchases[0].name == "SOME SHOP"

    def test_section_without_total_marker_runs_to_end_of_lines(self):
        """
        GIVEN a purchase section that is never closed by a Total Consumos marker
        WHEN it is parsed
        THEN the loop exhausts the lines and still emits the purchases it found
        """
        # GIVEN — no "Tarjeta NNNN Total Consumos" terminator after the row.
        text = "\n".join(
            [
                "N319",
                "30 50000845 4",
                "AMERICAN  EXPRESS",
                "CIERRE 28 May 26",
                "VENCIMIENTO 10 Jun 26",
                "____________________________",
                "15 Mayo 1 1234 * SOME SHOP 1.000,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — the row parsed even though the section never hit a terminator.
        purchases = [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE]
        assert len(purchases) == 1
        assert purchases[0].name == "SOME SHOP"

    def test_skip_marker_line_is_dropped(self):
        """
        GIVEN a transaction row whose description carries a skip marker
        WHEN it is parsed
        THEN it never becomes a purchase line (payments must not be recorded)
        """
        # GIVEN — a SU PAGO row inside the purchase section.
        text = _santander_amex_detail(["15 Mayo 1 1234 * SU PAGO EN PESOS 1.000,00"])

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.PURCHASE] == []

    def test_clean_description_strips_leading_code_and_trailing_reference(self):
        """
        GIVEN a description with a leading "digits*" code AND a trailing 7+-digit run
        WHEN _clean_description runs
        THEN both reference artefacts are stripped, leaving the merchant text
        """
        # GIVEN / WHEN / THEN
        cleaned = SantanderAmexParser._clean_description("648640*MERCADO LIBRE 12345678")
        assert cleaned == "MERCADO LIBRE"


class TestSantanderFeeEdgeCases:
    """Defensive branches in the Santander fee row parser."""

    def test_no_vencimiento_skips_the_whole_fee_section(self):
        """
        GIVEN a statement with no VENCIMIENTO (pay_date is None) carrying a fee row
        WHEN it is parsed
        THEN the fee section is skipped entirely (fees need a pay date)
        """
        # GIVEN — no VENCIMIENTO header, plus a well-formed fee line after the total.
        text = "\n".join(
            [
                "N319",
                "30 50000845 4",
                "AMERICAN  EXPRESS",
                "CIERRE 28 May 26",
                "____________________________",
                "15 Mayo 1 1234 * SOME SHOP 1.000,00",
                "Tarjeta 5678 Total Consumos 1.000,00",
                "10 Jun 26 IMPUESTO SELLOS $ 500,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — pay date is None, so no fee line is emitted.
        assert parsed.period_due is None
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []

    def test_non_matching_line_after_total_is_ignored(self):
        """
        GIVEN a line after the total marker that matches no fee shape
        WHEN it is parsed
        THEN it is skipped and the following real fee row still parses
        """
        # GIVEN — a free-text line (no $ separator) precedes a real fee row.
        text = "\n".join(
            [
                "N319",
                "30 50000845 4",
                "AMERICAN  EXPRESS",
                "CIERRE 28 May 26",
                "VENCIMIENTO 10 Jun 26",
                "____________________________",
                "15 Mayo 1 1234 * SOME SHOP 1.000,00",
                "Tarjeta 5678 Total Consumos 1.000,00",
                "some trailing legal disclosure text",
                "10 Jun 26 IMPUESTO SELLOS $ 500,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN — the disclosure line is ignored; the real fee survives.
        fees = [line for line in parsed.lines if line.line_kind is LineKind.FEE]
        assert len(fees) == 1
        assert fees[0].name == "IMPUESTO SELLOS"

    def test_zero_amount_fee_is_skipped(self):
        """
        GIVEN a fee row whose amount is zero
        WHEN it is parsed
        THEN no FEE line is emitted (non-positive fees are dropped)
        """
        # GIVEN — a fee line with a 0,00 amount after the total marker.
        text = "\n".join(
            [
                "N319",
                "30 50000845 4",
                "AMERICAN  EXPRESS",
                "CIERRE 28 May 26",
                "VENCIMIENTO 10 Jun 26",
                "____________________________",
                "15 Mayo 1 1234 * SOME SHOP 1.000,00",
                "Tarjeta 5678 Total Consumos 1.000,00",
                "10 Jun 26 IMPUESTO SELLOS $ 0,00",
            ]
        )

        # WHEN
        parsed = SantanderAmexParser().parse(text)

        # THEN
        assert [line for line in parsed.lines if line.line_kind is LineKind.FEE] == []


class TestSantanderFingerprints:
    """The Santander fingerprints discriminate AMEX from VISA on the header spacing."""

    def test_amex_requires_double_space_header(self):
        """
        GIVEN AMEX text using a single-space "AMERICAN EXPRESS" header
        WHEN the AMEX fingerprint runs
        THEN it does NOT match (the double space is the discriminator)
        """
        # THEN — double-space matches, single-space does not.
        assert SantanderAmexParser().fingerprint(_SANTANDER_AMEX_TEXT) is True
        single_space = _SANTANDER_AMEX_TEXT.replace("AMERICAN  EXPRESS", "AMERICAN EXPRESS")
        assert SantanderAmexParser().fingerprint(single_space) is False

    def test_visa_matches_only_without_amex_header(self):
        """
        GIVEN VISA text without the double-space AMEX header
        WHEN the VISA fingerprint runs
        THEN it matches, but text carrying the AMEX header is excluded
        """
        # THEN
        assert SantanderVisaParser().fingerprint(_SANTANDER_VISA_TEXT) is True
        with_amex = _SANTANDER_VISA_TEXT + "\nAMERICAN  EXPRESS"
        assert SantanderVisaParser().fingerprint(with_amex) is False

    def test_registry_contains_both_santander_parsers(self):
        """
        GIVEN the module-level BANK_PARSERS registry
        WHEN it is inspected
        THEN it carries both Santander parsers (AMEX before VISA)
        """
        # THEN
        assert any(isinstance(parser, SantanderAmexParser) for parser in BANK_PARSERS)
        assert any(isinstance(parser, SantanderVisaParser) for parser in BANK_PARSERS)


def _minimal_detail(cells: list[str]) -> str:
    """Build a minimal fingerprinting statement text with one detail row.

    Wraps the given DETALLE cells between the fingerprint markers, the detail
    header and the consumo-total terminator so the parser's section finder and
    fingerprint both engage, without the surrounding header/period chrome.
    """
    return "\n".join(
        [
            "Tarjeta Crédito VISA",
            "CUIT Banco: 30-50000173-5",
            "Resumen N° VI00000000069436867",
            "TARJETA 5771 Total Consumos de JUAN PEREZ ",
            "DETALLE DEL CONSUMO  ",
            *cells,
            "TARJETA 5771 Total Consumos de JUAN PEREZ ",
            "TOTAL A PAGAR",
            "1.000,00",
        ]
    )
