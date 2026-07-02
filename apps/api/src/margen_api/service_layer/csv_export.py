"""Pure CSV rendering for the reports export endpoints (ADR-128, ADR-165).

Renders the query-side read models into CSV text using Python's stdlib
:mod:`csv` — no ``openpyxl``, no ``pandas``, no new dependency (ADR-128). These
functions are pure (read model in, ``str`` out) so they are fast to unit test and
free of I/O; the entrypoint wraps the returned text in an HTTP ``Response`` with
the ``text/csv`` content type and an attachment ``Content-Disposition`` (ADR-165).

The header rows are STABLE, English, machine column names (this is a data export,
not a UI surface — no i18n, ADR-165). ``csv.writer`` handles quoting/escaping of
values containing commas, quotes or newlines and normalizes line endings, so the
output is faithful RFC-4180 CSV. Money is rendered as the plain :class:`Decimal`
string (ADR-025); ``None`` renders as an empty field.

User-controlled text cells (a transaction ``name``, a ``category``) are additionally
guarded against CSV formula injection: a spreadsheet (Excel, Sheets, LibreOffice)
evaluates a cell whose first character is a formula trigger (``= + - @``) or a
control character (TAB, CR), so a crafted value like ``=HYPERLINK("http://evil")``
would execute on open. We neutralize such a cell by prefixing a single quote ``'``
(the standard mitigation). RFC-4180 quoting still applies on top. Numeric/Decimal
cells are never touched.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Sequence
from decimal import Decimal

from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.summary_read_models import MonthlySummary

# The transactions export columns (ADR-165), faithful to the FX-snapshot money model
# (ADR-148/149): the authoritative ARS-equivalent ``amount`` plus the full snapshot
# (``usd_amount``, ``fx_rate``, ``fx_source``) and the reimbursement offset link.
_TRANSACTION_HEADER = (
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
)

# The per-category monthly summary export columns (ADR-165). ``amount`` is the
# ARS-equivalent net spend; ``share_pct`` and ``delta_pct`` mirror the summaries
# reader (ADR-042).
_SUMMARY_HEADER = ("category", "amount", "share_pct", "delta_pct")

# Leading characters a spreadsheet treats as the start of a formula or as control
# input. A cell beginning with any of these is neutralized with a leading quote so
# it is rendered as literal text on open, not executed (CSV formula injection).
_INJECTION_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


def _sanitize(text: str) -> str:
    """Neutralize a formula-injection trigger at the start of a text cell.

    A spreadsheet evaluates a cell whose first character is ``= + - @`` or a
    leading TAB/CR, so a crafted transaction ``name``/``category`` could execute on
    open. Prefixing a single quote ``'`` (the standard mitigation) forces the cell
    to render as literal text. A safe value is returned unchanged; ``csv.writer``
    still applies RFC-4180 quoting on top.
    """
    if text.startswith(_INJECTION_TRIGGERS):
        return f"'{text}"
    return text


def _text(value: object | None) -> str:
    """Render a cell value as text; ``None`` becomes an empty field.

    :class:`Decimal` and other scalars render via ``str`` so money keeps its exact
    Decimal representation (ADR-025); ``csv.writer`` then handles any quoting. Any
    ``str`` cell is passed through :func:`_sanitize` so a user-controlled value that
    starts with a formula/control trigger is neutralized centrally — every export
    (transactions, summary, and any future CSV) inherits the guard. Non-``str``
    scalars (``Decimal``, dates, UUIDs) are never a formula trigger and pass through.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return _sanitize(value)
    return str(value)


def _render(header: Sequence[str], rows: Sequence[Sequence[object | None]]) -> str:
    """Render a header + rows into CSV text via stdlib ``csv.writer``.

    Uses ``\\r\\n`` line terminators (RFC-4180) and lets ``csv.writer`` quote any
    field containing a comma, quote or newline. Writing into a ``StringIO`` keeps
    the function pure — the caller owns turning the text into an HTTP response.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    for row in rows:
        writer.writerow([_text(cell) for cell in row])
    return buffer.getvalue()


def transactions_csv(rows: Sequence[TransactionReadModel]) -> str:
    """Render transaction read models to CSV text (ADR-165).

    Emits the header row followed by one row per transaction in the order supplied
    by the caller (the reader lists newest-first, ADR-030). An empty ``rows`` yields
    a header-only CSV so the download is always a valid file. Every column is drawn
    from the read model with no derivation; ``None`` FX-snapshot fields render as
    empty cells.

    Args:
        rows: The owner's transaction read models to export.

    Returns:
        The CSV document as text.
    """
    return _render(
        _TRANSACTION_HEADER,
        [
            (
                row.id,
                row.occurred_on,
                row.name,
                row.kind,
                row.category,
                row.amount,
                row.currency,
                row.usd_amount,
                row.fx_rate,
                row.fx_source,
                row.account_id,
                row.offsets_transaction_id,
            )
            for row in rows
        ],
    )


def _delta(value: Decimal | None) -> str:
    """Render a category delta percentage; ``None`` (no prior base) becomes empty."""
    return "" if value is None else str(value)


def category_summary_csv(summary: MonthlySummary) -> str:
    """Render a month's category breakdown to CSV text (ADR-165, ADR-042).

    Emits the header row followed by one row per category in the summary's order
    (sorted by amount descending, ADR-042). A month with no expenses yields a
    header-only CSV. ``delta_pct`` renders empty when the prior month had no base
    for the category.

    Args:
        summary: The monthly summary whose ``categories`` breakdown to export.

    Returns:
        The CSV document as text.
    """
    return _render(
        _SUMMARY_HEADER,
        [
            (category.category, category.amount, category.share, _delta(category.delta_pct))
            for category in summary.categories
        ],
    )
