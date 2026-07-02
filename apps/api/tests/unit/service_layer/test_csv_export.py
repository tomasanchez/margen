"""Unit tests for the pure CSV export rendering (ADR-128, ADR-165).

These exercise the stdlib-``csv`` rendering with no I/O: the stable English header
rows, faithful transaction columns (including the FX snapshot), RFC-4180
quoting/escaping of values with commas / quotes / newlines, empty inputs yielding a
header-only file, and exact Decimal money formatting (ADR-025).
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

import pytest

from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType
from margen_api.service_layer.csv_export import category_summary_csv, transactions_csv
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.summary_read_models import (
    CategorySummary,
    MonthlySummary,
    TrendPoint,
)

_ID = UUID("11111111-1111-4111-8111-111111111111")
_ACCOUNT_ID = UUID("22222222-2222-4222-8222-222222222222")
_OFFSET_ID = UUID("33333333-3333-4333-8333-333333333333")
_MOMENT = datetime(2026, 1, 1)


def _transaction(
    *,
    name: str = "Coto",
    kind: Kind = Kind.EXPENSE,
    amount: str = "250.00",
    currency: Currency = Currency.ARS,
    category: str | None = "Food",
    usd_amount: Decimal | None = None,
    fx_rate: Decimal | None = None,
    fx_source: str | None = None,
    account_id: UUID | None = _ACCOUNT_ID,
    offsets_transaction_id: UUID | None = None,
) -> TransactionReadModel:
    """Build a transaction read model with export-relevant fields set."""
    return TransactionReadModel(
        id=_ID,
        occurred_on=date(2026, 6, 12),
        name=name,
        kind=kind,
        type=TxType.EXPENSE if kind is Kind.EXPENSE else TxType.INCOME,
        amount=Decimal(amount),
        currency=currency,
        usd_amount=usd_amount,
        fx_rate=fx_rate,
        fx_source=fx_source,
        fx_rate_type=FxRateType.MEP if fx_rate is not None else None,
        fx_rate_as_of=None,
        category=category,
        payment_method=None,
        card=None,
        notes=None,
        recurring=False,
        recurring_cadence=None,
        installments_total=None,
        installments_index=None,
        counts_toward_monotributo=False,
        statement_document_id=None,
        account_id=account_id,
        offsets_transaction_id=offsets_transaction_id,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _rows(csv_text: str) -> list[list[str]]:
    """Parse CSV text back into a list of string rows for assertions."""
    return list(csv.reader(io.StringIO(csv_text)))


class TestTransactionsCsv:
    """``transactions_csv`` renders the faithful transaction column set (ADR-165)."""

    async def test_header_is_the_stable_english_column_set(self):
        """
        GIVEN no transactions
        WHEN they are rendered to CSV
        THEN the output is a header-only file with the stable English columns
        """
        # WHEN
        rows = _rows(transactions_csv([]))

        # THEN — a valid file: exactly the header row.
        assert rows == [
            [
                "id",
                "occurred_on",
                "name",
                "kind",
                "category",
                "amount",
                "currency",
                "usd_amount",
                "fx_rate",
                "fx_source",
                "account_id",
                "offsets_transaction_id",
            ]
        ]

    async def test_ars_row_renders_native_amount_and_empty_fx_snapshot(self):
        """
        GIVEN an ARS expense with no FX snapshot
        WHEN it is rendered
        THEN the amount keeps its Decimal string and the USD/FX columns are empty
        """
        # WHEN
        rows = _rows(transactions_csv([_transaction()]))

        # THEN
        body = rows[1]
        assert body[1] == "2026-06-12"
        assert body[3] == "expense"
        assert body[5] == "250.00"
        assert body[6] == "ARS"
        # usd_amount, fx_rate, fx_source are empty for a plain ARS row.
        assert body[7] == ""
        assert body[8] == ""
        assert body[9] == ""
        assert body[10] == str(_ACCOUNT_ID)
        assert body[11] == ""

    async def test_usd_row_renders_full_fx_snapshot(self):
        """
        GIVEN a USD row carrying the full FX snapshot
        WHEN it is rendered
        THEN the usd_amount, fx_rate and fx_source columns are populated (ADR-148)
        """
        # WHEN
        rows = _rows(
            transactions_csv(
                [
                    _transaction(
                        currency=Currency.USD,
                        usd_amount=Decimal("50.00"),
                        fx_rate=Decimal("1000.000000"),
                        fx_source="bolsa",
                    )
                ]
            )
        )

        # THEN
        body = rows[1]
        assert body[6] == "USD"
        assert body[7] == "50.00"
        assert body[8] == "1000.000000"
        assert body[9] == "bolsa"

    async def test_offset_link_column_is_emitted(self):
        """
        GIVEN a reimbursement linked to an expense
        WHEN it is rendered
        THEN the offsets_transaction_id column carries the linked id
        """
        # WHEN
        rows = _rows(transactions_csv([_transaction(kind=Kind.REIMBURSEMENT, offsets_transaction_id=_OFFSET_ID)]))

        # THEN
        assert rows[1][3] == "reimbursement"
        assert rows[1][11] == str(_OFFSET_ID)

    async def test_names_with_commas_quotes_and_newlines_are_quoted_and_survive_roundtrip(self):
        """
        GIVEN names containing a comma, a double-quote and a newline
        WHEN they are rendered and parsed back
        THEN each value round-trips intact (csv.writer quotes/escapes them)
        """
        # GIVEN — three names exercising the three special characters.
        tricky = [
            _transaction(name="Coto, sucursal 3"),
            _transaction(name='He said "hi"'),
            _transaction(name="line1\nline2"),
        ]

        # WHEN
        text = transactions_csv(tricky)
        rows = _rows(text)

        # THEN — the parsed name column matches the originals exactly.
        assert rows[1][2] == "Coto, sucursal 3"
        assert rows[2][2] == 'He said "hi"'
        assert rows[3][2] == "line1\nline2"
        # A field with a comma is quoted in the raw text.
        assert '"Coto, sucursal 3"' in text

    @pytest.mark.parametrize(
        "trigger",
        ["=", "+", "-", "@", "\t", "\r"],
    )
    async def test_formula_injection_trigger_in_name_is_prefixed_with_quote(self, trigger: str):
        """
        GIVEN a transaction name that begins with a formula/control trigger
        WHEN it is rendered
        THEN the emitted name cell is neutralized with a leading single quote
        """
        # GIVEN — a crafted name a spreadsheet would otherwise evaluate on open.
        name = f'{trigger}HYPERLINK("http://evil","x")'

        # WHEN
        rows = _rows(transactions_csv([_transaction(name=name)]))

        # THEN — the cell is prefixed with a single quote (the standard mitigation).
        assert rows[1][2] == f"'{name}"

    @pytest.mark.parametrize(
        "trigger",
        ["=", "+", "-", "@", "\t", "\r"],
    )
    async def test_formula_injection_trigger_in_category_is_prefixed_with_quote(self, trigger: str):
        """
        GIVEN a transaction category that begins with a formula/control trigger
        WHEN it is rendered
        THEN the emitted category cell is neutralized with a leading single quote
        """
        # GIVEN
        category = f"{trigger}cmd|'/c calc'!A1"

        # WHEN
        rows = _rows(transactions_csv([_transaction(category=category)]))

        # THEN — category is column index 4.
        assert rows[1][4] == f"'{category}"

    async def test_normal_name_is_not_prefixed_but_still_quoted(self):
        """
        GIVEN an ordinary name with a comma but no leading trigger
        WHEN it is rendered
        THEN it round-trips unchanged (NO quote prefix) and is RFC-4180 quoted
        """
        # GIVEN — a benign business name; the comma forces RFC-4180 quoting only.
        name = "Café, S.A."

        # WHEN
        text = transactions_csv([_transaction(name=name)])
        rows = _rows(text)

        # THEN — no injection prefix; the value survives the round-trip verbatim.
        assert rows[1][2] == name
        assert not rows[1][2].startswith("'")
        # The comma-bearing value is RFC-4180 quoted in the raw text.
        assert '"Café, S.A."' in text


class TestCategorySummaryCsv:
    """``category_summary_csv`` renders the month's category breakdown (ADR-165, ADR-042)."""

    def _summary(self, categories: list[CategorySummary]) -> MonthlySummary:
        """Wrap categories in a monthly summary; the trend is irrelevant to the export."""
        return MonthlySummary(
            month="2026-06",
            trend=[TrendPoint(month="2026-06", expenses=Decimal("0"), current=True)],
            categories=categories,
        )

    async def test_header_only_when_no_categories(self):
        """
        GIVEN a month with no expenses
        WHEN the summary is rendered
        THEN the output is a header-only CSV with the stable columns
        """
        # WHEN
        rows = _rows(category_summary_csv(self._summary([])))

        # THEN
        assert rows == [["category", "amount", "share_pct", "delta_pct"]]

    async def test_rows_carry_amount_share_and_delta(self):
        """
        GIVEN two categories, one with a delta and one without
        WHEN the summary is rendered
        THEN each row carries the Decimal amount, share and delta (empty when None)
        """
        # GIVEN
        summary = self._summary(
            [
                CategorySummary(
                    category="Food",
                    amount=Decimal("250.50"),
                    share=Decimal("100"),
                    delta_pct=Decimal("150.5"),
                ),
                CategorySummary(
                    category="Uncategorized",
                    amount=Decimal("0"),
                    share=Decimal("0"),
                    delta_pct=None,
                ),
            ]
        )

        # WHEN
        rows = _rows(category_summary_csv(summary))

        # THEN
        assert rows[1] == ["Food", "250.50", "100", "150.5"]
        # A None delta renders as an empty field, not the string "None".
        assert rows[2] == ["Uncategorized", "0", "0", ""]

    async def test_formula_injection_category_is_prefixed_via_shared_guard(self):
        """
        GIVEN a summary category name beginning with a formula trigger
        WHEN the summary is rendered
        THEN the category cell is neutralized, proving the guard is inherited centrally
        """
        # GIVEN — the same guard as the transactions export, applied in ``_text``.
        summary = self._summary(
            [
                CategorySummary(
                    category="=1+1",
                    amount=Decimal("10.00"),
                    share=Decimal("100"),
                    delta_pct=None,
                ),
            ]
        )

        # WHEN
        rows = _rows(category_summary_csv(summary))

        # THEN
        assert rows[1][0] == "'=1+1"
