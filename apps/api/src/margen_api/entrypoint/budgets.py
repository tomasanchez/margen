"""Budgets REST entrypoint (ADR-125, ADR-040, ADR-130).

Owner-scoped budgets-vs-actuals over the month-navigator period, exposed under
``/budgets`` with the ``ResponseModel[T]`` envelope and camelCase JSON (ADR-030).
The GET reads through the query-side :class:`AbstractBudgetReader` (ADR-028); the
PUT (upsert) and DELETE (clear) go through the message bus as commands. A budget is
a per-category monthly target compared against the category's actual spend, reusing
the summaries category-actuals aggregation (ADR-042, ADR-125). Domain invariant
violations (ADR-031) are translated to HTTP here:

- :class:`UnknownCurrencyError` -> ``422 Unprocessable Entity``
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from margen_api.domain.commands.budget import ClearBudget
from margen_api.entrypoint.budgets_schemas import BudgetUpsertRequest, MonthlyBudgetResponse
from margen_api.entrypoint.dependencies import AuthUser, BudgetReader, Bus
from margen_api.entrypoint.schemas import ResponseModel

router = APIRouter(prefix="/budgets", tags=["Budgets"])

# Query param shape: a 4-digit year, a hyphen, then a 2-digit month (01-12).
_MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"
_MONTH_RE = re.compile(_MONTH_PATTERN)


def _current_month() -> str:
    """Return the current server month as ``YYYY-MM`` (UTC)."""
    today = datetime.now(UTC).date()
    return f"{today.year:04d}-{today.month:02d}"


def _parse_month(value: str) -> date:
    """Parse a ``YYYY-MM`` string into the first day of that month (ADR-040).

    The GET route's ``pattern`` already rejects malformed query params with ``422``
    before this runs; the PUT body's ``month`` carries no route pattern, so it is
    validated here too — a malformed body month also yields ``422``. ``date(...)``
    rejects an out-of-range month (e.g. ``2026-13``) with ``ValueError``.
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
    name="Monthly budgets",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[MonthlyBudgetResponse],
)
async def monthly_budget(
    reader: BudgetReader,
    user: AuthUser,
    month: Annotated[
        str | None,
        Query(
            pattern=_MONTH_PATTERN,
            description="Target month as 'YYYY-MM'. Defaults to the current server month.",
            examples=["2026-06"],
        ),
    ] = None,
) -> ResponseModel[MonthlyBudgetResponse]:
    """Return the caller's per-category targets vs actual spend for a month (ADR-125, ADR-108).

    Lists every expense category with its ``target`` (the budget amount, or ``null``
    when unset), its ``spent`` (the month's actual expense total for the category,
    from the summaries aggregation, ADR-042) and ``remaining`` (``target - spent``,
    ``null`` when no target). Scoped to ``user.id`` so a caller only sees their own
    budgets and spend (ADR-108). A malformed ``month`` yields ``422``.
    """
    target = _parse_month(month or _current_month())
    model = await reader.monthly_budget(target, user.id)
    return ResponseModel(data=MonthlyBudgetResponse.from_read_model(model))


@router.put(
    "",
    name="Upsert budget",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[MonthlyBudgetResponse],
)
async def upsert_budget(
    body: BudgetUpsertRequest,
    bus: Bus,
    reader: BudgetReader,
    user: AuthUser,
) -> ResponseModel[MonthlyBudgetResponse]:
    """Set or replace a category's target for a month and return the month's budgets (ADR-125, ADR-130).

    Dispatches an ``UpsertBudget`` command (stamped with ``user.id``) through the
    message bus, then re-reads the month's budgets-vs-actuals so the client gets the
    refreshed surface. The upsert is unique per ``(user, category, month)``, so a
    repeat for the same category/month replaces the target rather than duplicating it
    (ADR-125). An out-of-set ``currency`` or a malformed ``month`` is rejected with a
    ``422`` at boundary validation (the ``Currency`` enum field and the month parse)
    before the command is dispatched.
    """
    period = _parse_month(body.month)
    await bus.handle(body.to_command(period, user.id))
    model = await reader.monthly_budget(period, user.id)
    return ResponseModel(data=MonthlyBudgetResponse.from_read_model(model))


@router.delete(
    "",
    name="Clear budget",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_budget(
    bus: Bus,
    user: AuthUser,
    category: Annotated[str, Query(min_length=1, description="The expense category whose target to clear.")],
    month: Annotated[
        str,
        Query(pattern=_MONTH_PATTERN, description="The budget month as 'YYYY-MM'.", examples=["2026-06"]),
    ],
) -> None:
    """Clear a category's target for a month for the caller (ADR-125, ADR-130).

    Dispatches a ``ClearBudget`` command scoped to ``user.id``. Idempotent: clearing
    an absent target is a no-op, so the endpoint answers ``204`` whether or not a
    target existed (ADR-125). Scoped to ``user.id`` so a caller can only clear their
    own targets (ADR-130).
    """
    period = _parse_month(month)
    await bus.handle(ClearBudget(user_id=user.id, category=category, period=period))
