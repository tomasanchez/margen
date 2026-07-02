"""Reports REST entrypoint (ADR-163, ADR-164, ADR-165).

Query-only endpoints for the Reports page. Most report surfaces reuse the EXISTING
readers directly (summaries, budgets, accounts — ADR-163); this router adds only
the two net-new pieces:

* ``GET /reports/net-worth-history`` — the monthly net-worth series (ADR-164),
  returned as the ``ResponseModel[T]`` envelope with camelCase JSON (ADR-030).
* ``GET /reports/export/transactions`` and ``GET /reports/export/summary`` — CSV
  exports rendered by the pure :mod:`margen_api.service_layer.csv_export` and
  streamed as ``text/csv`` attachments (ADR-165).

Every route is owner-scoped: the reader filters by ``user.id`` (ADR-108/131) — a
client-supplied id is never trusted. The CSV routes follow the non-JSON response
precedent (``entrypoint/invoices.py``): a :class:`~fastapi.Response` carrying the
bytes, media type and ``Content-Disposition`` attachment header.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status

from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.dependencies import (
    AuthUser,
    ForecastReader,
    ReportsReader,
    SummaryReader,
    TransactionReader,
)
from margen_api.entrypoint.reports_schemas import (
    ForecastResponse,
    NetWorthHistoryResponse,
    ReportsOverviewResponse,
)
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.service_layer.csv_export import category_summary_csv, transactions_csv
from margen_api.service_layer.forecast import DEFAULT_HORIZON, MAX_HORIZON, MIN_HORIZON
from margen_api.service_layer.net_worth_history import DEFAULT_MONTHS, MAX_MONTHS, MIN_MONTHS
from margen_api.service_layer.reports_overview import ReportsRange

router = APIRouter(prefix="/reports", tags=["Reports"])

_CSV_MEDIA_TYPE = "text/csv; charset=utf-8"
# The month query param shape: a 4-digit year, a hyphen, then a 2-digit month.
_MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


def _parse_month(value: str) -> date:
    """Parse a ``YYYY-MM`` string into the first day of that month.

    The route's ``pattern`` rejects malformed input with ``422`` before this runs,
    so a parse failure here is unexpected and also surfaces as ``422``.
    """
    try:
        year_text, month_text = value.split("-")
        return date(int(year_text), int(month_text), 1)
    except ValueError as error:  # pragma: no cover - the route pattern guards this
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid month '{value}'; expected 'YYYY-MM'.",
        ) from error


def _attachment(content: str, filename: str) -> Response:
    """Build a ``text/csv`` attachment response for a CSV document (ADR-165)."""
    return Response(
        content=content,
        media_type=_CSV_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/overview",
    name="Reports overview",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[ReportsOverviewResponse],
)
async def overview(
    reader: ReportsReader,
    user: AuthUser,
    range_: Annotated[
        ReportsRange,
        Query(
            alias="range",
            description="The analytics window: '3M', '6M', '12M' or 'YTD' (ADR-167).",
            examples=["6M"],
        ),
    ] = ReportsRange.SIX_MONTHS,
    currency: Annotated[
        Currency,
        Query(description="The denomination currency: 'ARS' (default) or 'USD' (ADR-168)."),
    ] = Currency.ARS,
) -> ResponseModel[ReportsOverviewResponse]:
    """Return the caller's range-based Reports overview (ADR-167, ADR-169, ADR-131).

    Resolves ``range`` into the current month-window ending at the current month and
    the immediately-preceding equal-length window (``YTD``'s previous is the same
    span in the prior year), then assembles the KPI strip (income, expenses, net
    saved, savings rate — current and previous for deltas), the oldest-first
    per-month cash-flow series, the per-category trends (total, share, a
    trailing-6-month sparkline and the vs-previous delta) and the FX summary (average
    captured MEP rate, USD invoiced, per-month rate series).

    Every figure is denominated in ``currency`` (ADR-168): ``ARS`` sums the
    authoritative ``amount``; ``USD`` sums the ``usd_amount`` snapshot, excludes rows
    that lack one and surfaces their count as ``unconverted`` so a USD total is never
    silently understated (ADR-152). The overview is scoped to ``user.id`` so a caller
    only sees their own data (ADR-108, ADR-131). An out-of-set ``range`` or
    ``currency`` is rejected with ``422`` at boundary validation.
    """
    model = await reader.overview(user.id, range_key=range_.value, currency=currency)
    return ResponseModel(data=ReportsOverviewResponse.from_read_model(model))


@router.get(
    "/forecast",
    name="Cash-flow forecast",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[ForecastResponse],
)
async def forecast(
    reader: ForecastReader,
    user: AuthUser,
    horizon: Annotated[
        int,
        Query(
            ge=MIN_HORIZON,
            le=MAX_HORIZON,
            description="Number of forward months to project (1..12, default 6). Starts the month AFTER this one.",
            examples=[6],
        ),
    ] = DEFAULT_HORIZON,
    currency: Annotated[
        Currency,
        Query(description="The denomination currency: 'ARS' (default) or 'USD' (ADR-168)."),
    ] = Currency.ARS,
) -> ResponseModel[ForecastResponse]:
    """Return the caller's schedule/commitment-driven cash-flow forecast (ADR-176, ADR-177, ADR-131).

    Projects a forward per-month series over ``horizon`` months (starting the month
    AFTER the current month) of COMMITTED outflows only (v1: no discretionary band, no
    projected income): flagged recurring subscription streams repeated on their cadence,
    instalment tails (remaining cuotas), and the configured monotributo monthly cuota as
    a committed AFIP-ARS tax outflow in every month (ADR-177). A stream projects only
    into months strictly after its latest actual occurrence, so actuals own the past and
    projection owns the future (no double-count, ADR-176).

    Every figure is denominated in ``currency`` (ADR-168): ``ARS`` sums the authoritative
    ``amount``; ``USD`` sums the ``usd_amount`` snapshot, excludes committed rows that
    lack one and surfaces their count as ``unconverted`` so a USD total is never silently
    understated (ADR-152). The monotributo cuota is AFIP-ARS and is included at its ARS
    value on both paths (ADR-177). The forecast is scoped to ``user.id`` so a caller only
    sees their own commitments (ADR-108, ADR-131). An out-of-range ``horizon`` or
    out-of-set ``currency`` is rejected with ``422`` at boundary validation.
    """
    model = await reader.forecast(user.id, horizon=horizon, currency=currency)
    return ResponseModel(data=ForecastResponse.from_read_model(model))


@router.get(
    "/net-worth-history",
    name="Net-worth history",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[NetWorthHistoryResponse],
)
async def net_worth_history(
    reader: ReportsReader,
    user: AuthUser,
    months: Annotated[
        int,
        Query(
            ge=MIN_MONTHS,
            le=MAX_MONTHS,
            description="Number of months ending at the current month.",
            examples=[12],
        ),
    ] = DEFAULT_MONTHS,
) -> ResponseModel[NetWorthHistoryResponse]:
    """Return the caller's monthly net-worth history, oldest-first (ADR-164, ADR-131).

    Each month carries the cumulative month-END NATIVE balance per currency
    (``arsTotal`` / ``usdTotal``): opening balances + signed transaction deltas +
    net transfer flow up to and including the month (ADR-122/135). The backend
    performs no currency conversion — the frontend converts each pair at the live
    MEP rate (ADR-164). The series is scoped to ``user.id`` so a caller only sees
    their own accounts (ADR-108/131). The ``months`` window is clamped to the
    supported range.
    """
    history = await reader.net_worth_history(user.id, months=months)
    return ResponseModel(data=NetWorthHistoryResponse.from_read_model(history))


@router.get(
    "/export/transactions",
    name="Export transactions CSV",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={status.HTTP_200_OK: {"content": {"text/csv": {}}, "description": "The transactions as CSV."}},
)
async def export_transactions(
    reader: TransactionReader,
    user: AuthUser,
    from_: Annotated[
        date | None,
        Query(alias="from", description="Inclusive lower bound on occurred_on (YYYY-MM-DD)."),
    ] = None,
    to: Annotated[
        date | None,
        Query(description="Inclusive upper bound on occurred_on (YYYY-MM-DD)."),
    ] = None,
) -> Response:
    """Export the caller's transactions as CSV, optionally date-filtered (ADR-165, ADR-131).

    Lists the owner's transactions through the owner-scoped reader (ADR-108) and
    keeps those whose ``occurred_on`` falls within the optional inclusive
    ``[from, to]`` bounds — both omitted exports all of the caller's transactions.
    The rows are rendered by the pure CSV writer (ADR-165) and returned as a
    ``text/csv`` attachment. The filename encodes the applied bounds (or ``all``).
    """
    rows = await reader.list_transactions(user.id)
    if from_ is not None:
        rows = [row for row in rows if row.occurred_on >= from_]
    if to is not None:
        rows = [row for row in rows if row.occurred_on <= to]
    lower = from_.isoformat() if from_ is not None else "all"
    upper = to.isoformat() if to is not None else "all"
    filename = f"margen-transactions-{lower}-{upper}.csv"
    return _attachment(transactions_csv(rows), filename)


@router.get(
    "/export/summary",
    name="Export monthly summary CSV",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={status.HTTP_200_OK: {"content": {"text/csv": {}}, "description": "The category summary as CSV."}},
)
async def export_summary(
    reader: SummaryReader,
    user: AuthUser,
    month: Annotated[
        str | None,
        Query(
            pattern=_MONTH_PATTERN,
            description="Target month as 'YYYY-MM'. Defaults to the current server month.",
            examples=["2026-06"],
        ),
    ] = None,
) -> Response:
    """Export a month's category breakdown as CSV (ADR-165, ADR-042, ADR-131).

    Reuses the summaries reader (ADR-042) scoped to ``user.id`` (ADR-108) and
    renders its ``categories`` breakdown via the pure CSV writer. The month
    defaults to the current server month; a malformed ``month`` yields ``422``. The
    filename encodes the exported month.
    """
    today = datetime.now(UTC).date()
    target_month = month or f"{today.year:04d}-{today.month:02d}"
    summary = await reader.monthly_summary(_parse_month(target_month), user.id)
    filename = f"margen-summary-{target_month}.csv"
    return _attachment(category_summary_csv(summary), filename)
