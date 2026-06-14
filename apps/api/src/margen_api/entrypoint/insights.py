"""Monthly insights REST entrypoint (ADR-060, ADR-061).

A query-only endpoint serving the Home Insights card via server-side SQL
aggregation over the existing ``transactions`` table -- no new table, command or
aggregate, mirroring summaries (ADR-042). Reads go through the query-side
:class:`AbstractInsightsReader` (ADR-028) and return the ``ResponseModel[T]``
envelope with camelCase JSON (ADR-030). The endpoint returns *structured facts*,
not pre-formatted prose -- the frontend formats them (ADR-061).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from margen_api.entrypoint.dependencies import InsightsReader
from margen_api.entrypoint.insights_schemas import MonthlyInsightsResponse
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/insights", tags=["Insights"])

# Query param shape: a 4-digit year, a hyphen, then a 2-digit month (01-12).
_MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


def _today() -> date:
    """Return the current server date (UTC), the projection reference."""
    return datetime.now(UTC).date()


def _current_month() -> str:
    """Return the current server month as ``YYYY-MM`` (UTC)."""
    today = _today()
    return f"{today.year:04d}-{today.month:02d}"


def _parse_month(value: str) -> date:
    """Parse a ``YYYY-MM`` string into the first day of that month.

    The route's ``pattern`` already rejects malformed input with ``422`` before
    this runs, so a parse failure here is unexpected and surfaces as ``422`` too.
    """
    try:
        year_text, month_text = value.split("-")
        return date(int(year_text), int(month_text), 1)
    except ValueError as error:  # pragma: no cover - the route pattern guards this
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid month '{value}'; expected 'YYYY-MM'.",
        ) from error


@router.get(
    "",
    name="Monthly insights",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[MonthlyInsightsResponse],
)
async def monthly_insights(
    reader: InsightsReader,
    month: Annotated[
        str | None,
        Query(
            pattern=_MONTH_PATTERN,
            description="Target month as 'YYYY-MM'. Defaults to the current server month.",
            examples=["2026-06"],
        ),
    ] = None,
) -> ResponseModel[MonthlyInsightsResponse]:
    """Return the structured insight facts for a month (ADR-060, ADR-061).

    The facts are the biggest positive expense category mover versus the prior
    month, the recurring-expense footprint (count + total), the month's savings
    (income + invoice minus expenses -- projected to month-end for the current
    month, actual for a past month), and the latest USD transaction carrying an
    applied rate. Each fact is ``null`` when its underlying data does not exist
    (savings excepted), so the card renders only what applies. Money is serialized
    as ``Decimal`` strings (ADR-025) and the frontend composes the prose itself.
    A malformed ``month`` yields ``422``.
    """
    target = _parse_month(month or _current_month())
    insights = await reader.monthly_insights(target, _today())
    return ResponseModel(data=MonthlyInsightsResponse.from_read_model(insights))
