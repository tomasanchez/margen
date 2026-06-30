"""Application handlers for the budget aggregate (ADR-125, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain;
handlers contain no SQLAlchemy and no validation of their own (AGENTS.md). Every
write is owner-scoped (ADR-130). The upsert resolves an existing target by
``(category, period)`` for the owner so a category never gets a duplicate target for
a month (the UNIQUE constraint, ADR-125).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.commands.budget import (
    ApplySavingProfile,
    ClearBudget,
    RepriceMonth,
    UpsertBudget,
    UpsertBudgetIncome,
)
from margen_api.domain.models.budget import Budget, build_budget, month_start
from margen_api.domain.models.budget_income import BudgetIncome, build_budget_income
from margen_api.domain.models.exceptions import MissingIncomeBaseError
from margen_api.domain.models.reprice import reprice_cap
from margen_api.domain.models.saving_profiles import SavingProfile, compute_saving_rows, profile_total_pct
from margen_api.domain.models.strategy import FloorGuard, floor_guard
from margen_api.domain.models.value_objects import BudgetKind, Currency
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork


@dataclass(frozen=True, slots=True)
class ApplyProfileResult:
    """The outcome of applying a saving profile (ADR-138, budget-design §9.1.4).

    Attributes:
        floor_breached: Whether the chosen profile would push essentials below the
            household floor — the rows are still written; this is an advisory flag
            the UI surfaces (warn, never silently rebalance).
        gap: How far essentials fall short of the floor when ``floor_breached``, a
            non-negative magnitude (``0`` when not breached).
    """

    floor_breached: bool
    gap: Decimal


async def upsert_budget(command: UpsertBudget, uow: AbstractUnitOfWork) -> UUID:
    """Set or replace a category's monthly target for the caller (ADR-125, ADR-130).

    Resolves any existing target for ``(user_id, category, period)`` scoped to the
    owner (ADR-130). When one exists its amount/currency are replaced in place
    (preserving identity, ``created_at`` and ownership, bumping ``updated_at``) so
    the UNIQUE constraint is never violated; otherwise a fresh target is inserted
    with a generated id and timestamps (ADR-026). Invariants run via the domain
    factory (known currency, period normalized to the first of the month, ADR-031).

    Args:
        command: The validated upsert request, stamped with the authenticated owner.
        uow: The unit of work providing the budget repository.

    Returns:
        The UUID identity of the inserted or replaced target.

    Raises:
        UnknownCurrencyError: When ``command.currency`` is not a known currency
            (mapped to 422 at the boundary, ADR-031).
    """
    kind = BudgetKind.parse(command.kind)
    period = month_start(command.period)
    async with uow:
        existing = await uow.budgets.get_by_category_period(command.category, period, command.user_id, kind)
        budget = _build_upserted(command, existing, period, kind)
        if existing is None:
            uow.budgets.add(budget)
        else:
            await uow.budgets.persist(budget)
        await uow.commit()
    return budget.id


def _build_upserted(command: UpsertBudget, existing: Budget | None, period: date, kind: BudgetKind) -> Budget:
    """Build the target to persist: a fresh insert or the replaced existing row.

    A replace preserves identity, ``created_at`` and ownership and bumps
    ``updated_at`` to now; an insert generates them (ADR-026, ADR-130). Both run the
    domain invariants via :func:`build_budget`.
    """
    now = datetime.now(UTC)
    return build_budget(
        budget_id=existing.id if existing is not None else uuid4(),
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
        user_id=command.user_id,
        category=command.category,
        period=period,
        amount=command.amount,
        currency=command.currency,
        kind=kind,
    )


async def clear_budget(command: ClearBudget, uow: AbstractUnitOfWork) -> bool:
    """Clear a category's target for a month for the caller (ADR-125, ADR-130).

    Deletes the owner's target for ``(category, period)`` scoped to ``user_id``
    (ADR-130). Idempotent: clearing an absent target is a no-op that reports a miss,
    so the boundary answers ``204`` either way (ADR-125).

    Args:
        command: The validated clear request, stamped with the authenticated owner.
        uow: The unit of work providing the budget repository.

    Returns:
        ``True`` when a target was removed, ``False`` when none existed.
    """
    kind = BudgetKind.parse(command.kind)
    period = month_start(command.period)
    async with uow:
        removed = await uow.budgets.delete(command.category, period, command.user_id, kind)
        await uow.commit()
    return removed


async def upsert_budget_income(command: UpsertBudgetIncome, uow: AbstractUnitOfWork) -> UUID:
    """Set or replace a month's net-income base + household floor (ADR-139, ADR-130).

    Resolves any existing base for ``(user_id, period)`` scoped to the owner
    (ADR-130). When one exists its amount/currency/floor are replaced in place
    (preserving identity, ``created_at`` and ownership, bumping ``updated_at``) so the
    UNIQUE constraint is never violated; otherwise a fresh base is inserted with a
    generated id and timestamps (ADR-026). Invariants run via the domain factory
    (known currency, period normalized to the first of the month, ADR-031).

    Args:
        command: The validated upsert request, stamped with the authenticated owner.
        uow: The unit of work providing the income repository.

    Returns:
        The UUID identity of the inserted or replaced income base.

    Raises:
        UnknownCurrencyError: When ``command.currency`` is not a known currency
            (mapped to 422 at the boundary, ADR-031).
    """
    period = month_start(command.period)
    now = datetime.now(UTC)
    async with uow:
        existing = await uow.budget_income.get_by_period(period, command.user_id)
        income = build_budget_income(
            income_id=existing.id if existing is not None else uuid4(),
            created_at=existing.created_at if existing is not None else now,
            updated_at=now,
            user_id=command.user_id,
            period=period,
            amount=command.amount,
            currency=command.currency,
            floor_amount=command.floor_amount,
            floor_source=command.floor_source,
        )
        if existing is None:
            uow.budget_income.add(income)
        else:
            await uow.budget_income.persist(income)
        await uow.commit()
    return income.id


async def apply_saving_profile(command: ApplySavingProfile, uow: AbstractUnitOfWork) -> ApplyProfileResult:
    """Write a saving profile's bucket allocations as ``kind='saving'`` rows (ADR-138, ADR-130).

    Reads the month's net-income base (the percentages apply to it) and derives each
    saving bucket's amount via the pure :func:`compute_saving_rows`. Each bucket is
    upserted as a ``kind='saving'`` budget row in ONE unit of work, idempotent via the
    widened UNIQUE so re-applying overwrites rather than duplicates (ADR-138). Runs
    the floor-before-percentages guard over the SIX profile buckets (the spend-side
    ``MaintenanceReserve`` is not part of the to-savings total, budget-design §9.1.4)
    and returns whether the profile would underfund the household floor — the rows are
    still written; the flag is advisory (warn, never silently rebalance).

    Args:
        command: The validated apply request, stamped with the authenticated owner.
        uow: The unit of work providing the budget + income repositories.

    Returns:
        An :class:`ApplyProfileResult` carrying the floor-breach flag and gap.

    Raises:
        UnknownSavingProfileError: When ``command.profile`` is not a known preset
            (mapped to 422 at the boundary, ADR-031).
        MissingIncomeBaseError: When the month has no net-income base (mapped to 409
            at the boundary — the user must set income first, ADR-139).
    """
    profile = SavingProfile.parse(command.profile)
    period = month_start(command.period)
    now = datetime.now(UTC)
    async with uow:
        base = await uow.budget_income.get_by_period(period, command.user_id)
        if base is None:
            raise MissingIncomeBaseError(period)
        rows = compute_saving_rows(base.amount, profile)
        for bucket, amount in rows.items():
            await _upsert_saving_row(uow, command.user_id, bucket, period, amount, now)
        guard = _profile_floor_guard(base, profile)
        await uow.commit()
    return ApplyProfileResult(floor_breached=guard.breached, gap=guard.gap)


async def _upsert_saving_row(
    uow: AbstractUnitOfWork,
    user_id: str,
    bucket: str,
    period: date,
    amount: Decimal,
    now: datetime,
) -> None:
    """Insert or replace one ``kind='saving'`` bucket row in place (ADR-138, ADR-130)."""
    existing = await uow.budgets.get_by_category_period(bucket, period, user_id, BudgetKind.SAVING)
    row = build_budget(
        budget_id=existing.id if existing is not None else uuid4(),
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
        user_id=user_id,
        category=bucket,
        period=period,
        amount=amount,
        kind=BudgetKind.SAVING,
    )
    if existing is None:
        uow.budgets.add(row)
    else:
        await uow.budgets.persist(row)


def _profile_floor_guard(base: BudgetIncome, profile: SavingProfile) -> FloorGuard:
    """Run the floor-before-percentages guard for a profile against a base (budget-design §9.1.4).

    The to-savings total is the profile's headline percentage of net income (the six
    investing/goal buckets, excluding the spend-side maintenance reserve). With no
    floor set the guard cannot breach (no floor to underfund).
    """
    floor = base.floor_amount if base.floor_amount is not None else Decimal(0)
    saving_total = (base.amount * Decimal(profile_total_pct(profile)) / Decimal(100)).quantize(Decimal("0.01"))
    return floor_guard(base.amount, floor, saving_total)


async def reprice_month(command: RepriceMonth, uow: AbstractUnitOfWork) -> int:
    """Reprice the owner's spend caps from one month into another (ADR-137, ADR-130).

    Reads the source month's ``kind='spend'`` targets and, for each, computes the new
    cap via the pure :func:`reprice_cap` (``round(cap x (1 + infl/100)) + step_up``),
    upserting it into the target month as a ``kind='spend'`` row in one unit of work
    (idempotent via the widened UNIQUE). Saving rows are never repriced — they
    re-derive from the net-income base (ADR-137/138). A per-category ``step_up`` is
    applied when present in ``command.step_ups``; absent categories get a zero
    step-up.

    Args:
        command: The validated reprice request, stamped with the authenticated owner.
        uow: The unit of work providing the budget repository.

    Returns:
        The number of spend caps repriced into the target month.
    """
    from_period = month_start(command.from_period)
    to_period = month_start(command.to_period)
    now = datetime.now(UTC)
    async with uow:
        source = await uow.budgets.list_by_period(from_period, command.user_id, BudgetKind.SPEND)
        for cap in source:
            step_up = command.step_ups.get(cap.category, Decimal(0))
            new_amount = reprice_cap(cap.amount, command.monthly_inflation, step_up)
            await _upsert_spend_row(uow, command.user_id, cap.category, to_period, new_amount, cap.currency, now)
        await uow.commit()
    return len(source)


async def _upsert_spend_row(
    uow: AbstractUnitOfWork,
    user_id: str,
    category: str,
    period: date,
    amount: Decimal,
    currency: Currency,
    now: datetime,
) -> None:
    """Insert or replace one ``kind='spend'`` cap row in place (ADR-137, ADR-130)."""
    existing = await uow.budgets.get_by_category_period(category, period, user_id, BudgetKind.SPEND)
    row = build_budget(
        budget_id=existing.id if existing is not None else uuid4(),
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
        user_id=user_id,
        category=category,
        period=period,
        amount=amount,
        currency=currency,
        kind=BudgetKind.SPEND,
    )
    if existing is None:
        uow.budgets.add(row)
    else:
        await uow.budgets.persist(row)
