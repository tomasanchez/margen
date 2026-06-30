"""Budget-income REST entrypoint (ADR-139, ADR-143, ADR-040, ADR-130).

Owner-scoped net-income-base + household-floor over the month-navigator period,
exposed under ``/budget-income`` with the ``ResponseModel[T]`` envelope and camelCase
JSON (ADR-030). The GET reads through the query-side
:class:`AbstractBudgetIncomeReader` (ADR-028); the PUT (upsert) goes through the
message bus as a command. ``GET /budget-income/suggested`` returns the conservative
variable-income suggestion (lower-of trailing-12-average vs lowest month; null when
<12 months of ledger history), offered for the user to accept into the manual base
(suggest/confirm, ADR-044). Domain invariant violations (ADR-031) are translated to
HTTP here:

- :class:`UnknownCurrencyError` -> ``422 Unprocessable Entity`` (boundary enum field)
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from margen_api.entrypoint.budget_income_schemas import (
    BudgetIncomeResponse,
    BudgetIncomeUpsertRequest,
    SuggestedBaseResponse,
)
from margen_api.entrypoint.dependencies import AuthUser, BudgetIncomeReader, Bus
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/budget-income", tags=["Budgets"])

# Query param shape: a 4-digit year, a hyphen, then a 2-digit month (01-12).
_MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"
_MONTH_RE = re.compile(_MONTH_PATTERN)


def _current_month() -> str:
    """Return the current server month as ``YYYY-MM`` (UTC)."""
    today = datetime.now(UTC).date()
    return f"{today.year:04d}-{today.month:02d}"


def _parse_month(value: str) -> date:
    """Parse a ``YYYY-MM`` string into the first day of that month (ADR-040).

    The GET route's ``pattern`` already rejects malformed query params with ``422``;
    the PUT body's ``month`` carries no route pattern, so it is validated here too.
    """
    if not _MONTH_RE.match(value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid month '{value}'; expected 'YYYY-MM'.",
        )
    year_text, month_text = value.split("-")
    return date(int(year_text), int(month_text), 1)


@router.get(
    "",
    name="Budget income",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[BudgetIncomeResponse],
)
async def get_budget_income(
    reader: BudgetIncomeReader,
    user: AuthUser,
    month: Annotated[
        str | None,
        Query(
            pattern=_MONTH_PATTERN,
            description="Target month as 'YYYY-MM'. Defaults to the current server month.",
            examples=["2026-06"],
        ),
    ] = None,
) -> ResponseModel[BudgetIncomeResponse]:
    """Return the caller's net-income base + household floor for a month (ADR-139, ADR-143).

    Scoped to ``user.id`` (ADR-130). A month with no base reads back ``null`` amount/
    source/floor. A malformed ``month`` yields ``422``.
    """
    target = _parse_month(month or _current_month())
    model = await reader.income(target, user.id)
    return ResponseModel(data=BudgetIncomeResponse.from_read_model(model))


@router.put(
    "",
    name="Upsert budget income",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[BudgetIncomeResponse],
)
async def upsert_budget_income(
    body: BudgetIncomeUpsertRequest,
    bus: Bus,
    reader: BudgetIncomeReader,
    user: AuthUser,
) -> ResponseModel[BudgetIncomeResponse]:
    """Set or replace the caller's net-income base + floor for a month (ADR-139, ADR-130).

    Dispatches an ``UpsertBudgetIncome`` command (stamped with ``user.id``), then
    re-reads the base so the client gets the refreshed readout. Unique per
    ``(user, month)``, so a repeat replaces rather than duplicates (ADR-139). An
    out-of-set ``currency`` or malformed ``month`` is ``422`` at boundary validation.
    """
    period = _parse_month(body.month)
    await bus.handle(body.to_command(period, user.id))
    model = await reader.income(period, user.id)
    return ResponseModel(data=BudgetIncomeResponse.from_read_model(model))


@router.get(
    "/suggested",
    name="Suggested income base",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[SuggestedBaseResponse],
)
async def get_suggested_base(
    reader: BudgetIncomeReader,
    user: AuthUser,
    month: Annotated[
        str | None,
        Query(
            pattern=_MONTH_PATTERN,
            description="Reference month as 'YYYY-MM'. Defaults to the current server month.",
            examples=["2026-06"],
        ),
    ] = None,
) -> ResponseModel[SuggestedBaseResponse]:
    """Return the conservative variable-income suggestion, or ``null`` (ADR-139).

    Applies the lower-of-trailing-12-average-vs-lowest-month rule over the caller's
    income ledger ending at ``month``; ``null`` when fewer than 12 months exist.
    Scoped to ``user.id`` (ADR-130). A malformed ``month`` yields ``422``.
    """
    target = _parse_month(month or _current_month())
    suggested = await reader.suggested_base(target, user.id)
    return ResponseModel(data=SuggestedBaseResponse(suggested_base=suggested))
