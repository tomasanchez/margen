"""Monthly summaries REST entrypoint (ADR-042).

A query-only endpoint serving the Home spending trend and category breakdown via
server-side SQL aggregation over the existing ``transactions`` table — no new
table, command or aggregate (ADR-042). Reads go through the query-side
:class:`AbstractSummaryReader` (ADR-028) and return the ``ResponseModel[T]``
envelope with camelCase JSON (ADR-030).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from margen_api.entrypoint.dependencies import AuthUser, SummaryReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.summaries_schemas import MonthlySummaryResponse

router = APIRouter(prefix="/summaries", tags=["Summaries"])

# Query param shape: a 4-digit year, a hyphen, then a 2-digit month (01-12).
_MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


def _current_month() -> str:
    """Return the current server month as ``YYYY-MM`` (UTC)."""
    today = datetime.now(UTC).date()
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
    name="Monthly summary",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[MonthlySummaryResponse],
)
async def monthly_summary(
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
) -> ResponseModel[MonthlySummaryResponse]:
    """Return the caller's spending trend and category breakdown for a month (ADR-042, ADR-108).

    The ``trend`` carries the 6 calendar months ending at ``month`` (oldest-first,
    the requested month flagged ``current``), each with its total expenses. The
    ``categories`` breakdown lists the requested month's expenses by category,
    sorted by amount descending, with each category's ``share`` of the month total
    and ``deltaPct`` versus the prior month. Income and invoice kinds are excluded.
    The summary is scoped to ``user.id`` so a caller only sees their own spending
    (ADR-108). A malformed ``month`` yields ``422``.
    """
    target = _parse_month(month or _current_month())
    summary = await reader.monthly_summary(target, user.id)
    return ResponseModel(data=MonthlySummaryResponse.from_read_model(summary))
