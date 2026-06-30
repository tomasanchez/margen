"""The ``BudgetIncome`` aggregate root (ADR-139, budget-design §9.1.1).

The net spendable income base every budget percentage is applied to — NOT gross
collections (product-deliverable §2.1). A per-month, per-user row (the wrong
cardinality for an ``app_settings`` singleton, which is period-agnostic): income is
period-scoped and must align to the month navigator (ADR-040), so it is keyed
``(user_id, period)``.

The row also co-locates the **household floor** (ADR-143, budget-design §9.1.1): the
essentials spend the plan must never underfund, with a ``floor_source`` of
``manual`` (the user typed it) or ``computed`` (``Σ`` essential spend targets). The
floor lives here — not in a separate ``BudgetPlan`` table or settings scalar —
because it is per-period and read together with income (the essentials-floor-vs-
income readout).

Like :class:`~margen_api.domain.models.budget.Budget` it is a plain Python aggregate
(no Pydantic, no SQLAlchemy, no I/O) carrying the per-user owner (ADR-130). Money is
:class:`~decimal.Decimal` (ADR-025); the MVP base currency is ARS (ADR-125). The
``source`` / ``floor_source`` are tolerant strings (``manual`` for the MVP;
``monotributo`` / ``computed`` are Phase-3 / computed values, ADR-139).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.budget import month_start
from margen_api.domain.models.value_objects import Currency

ZERO = Decimal("0")
CENTS = Decimal("0.01")

# The variable-income base needs a full year of ledger history to be meaningful
# (product-deliverable §2.1 / §5.7); below this it degrades to a manual base
# (the suggestion returns ``None``).
_MIN_MONTHS_FOR_VARIABLE_BASE = 12

# Provenance tokens for the income base and the floor (ADR-139, ADR-143). Tolerant
# strings (no schema enum): ``manual`` is the MVP source; ``monotributo`` (income)
# is Phase 3, ``computed`` (floor) is the Σ-essential-targets value.
SOURCE_MANUAL = "manual"
FLOOR_SOURCE_MANUAL = "manual"
FLOOR_SOURCE_COMPUTED = "computed"


@dataclass(eq=False)
class BudgetIncome:
    """A month's net spendable income base + household floor, the aggregate root (ADR-139).

    ``amount`` is the net spendable income for ``period`` (take-home for salaried;
    ``collected - tax reserve - business costs`` for independent, product-deliverable
    §2.1), a positive ARS-equivalent magnitude (ADR-025). ``floor_amount`` is the
    optional household floor (essentials the plan must cover, budget-design §9.1.1);
    ``None`` when the user has not set or computed one.

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every row is attributable and scoped to its
            owner (ADR-130). ``None`` only for legacy/unowned construction.
        period: The income month, normalized to the first day of the month
            (ADR-040), so a user has at most one base per month (the upsert key).
        amount: The month's net spendable income, a positive ARS-equivalent
            magnitude (ADR-025).
        currency: The base currency; ARS for the MVP (ADR-125).
        source: Provenance of ``amount`` — ``manual`` (MVP) or ``monotributo``
            (Phase 3); a tolerant string (ADR-139).
        floor_amount: The household floor (essentials spend) for the month, or
            ``None`` when unset (ADR-143).
        floor_source: Provenance of ``floor_amount`` — ``manual`` (user typed) or
            ``computed`` (Σ essential spend targets); a tolerant string (ADR-143).
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    user_id: str | None
    period: date
    amount: Decimal = ZERO
    currency: Currency = Currency.ARS
    source: str = SOURCE_MANUAL
    floor_amount: Decimal | None = None
    floor_source: str = FLOOR_SOURCE_MANUAL
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.currency = Currency.parse(self.currency)
        self.period = month_start(self.period)
        self._normalize()

    def _normalize(self) -> None:
        """Coerce money fields to ``Decimal`` (ADR-025); other fields stay as-given."""
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        if self.floor_amount is not None and not isinstance(self.floor_amount, Decimal):
            self.floor_amount = Decimal(str(self.floor_amount))


def build_budget_income(
    *,
    period: date,
    amount: Decimal = ZERO,
    currency: Currency | str = Currency.ARS,
    source: str = SOURCE_MANUAL,
    floor_amount: Decimal | None = None,
    floor_source: str = FLOOR_SOURCE_MANUAL,
    user_id: str | None = None,
    income_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> BudgetIncome:
    """Construct a valid :class:`BudgetIncome`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience; the application handler injects them so production performs no
    implicit clock or UUID reads. Invariants run inside ``BudgetIncome.__post_init__``.

    Args:
        period: Any date in the income month; normalized to the first of the month.
        amount: The month's net spendable income; defaults to ``0``.
        currency: ARS (MVP) as ``Currency`` or string (ADR-125).
        source: Provenance of the amount; defaults to ``manual`` (ADR-139).
        floor_amount: The household floor, or ``None`` when unset (ADR-143).
        floor_source: Provenance of the floor; defaults to ``manual`` (ADR-143).
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        income_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``BudgetIncome`` aggregate.

    Raises:
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    return BudgetIncome(
        id=income_id if income_id is not None else uuid4(),
        user_id=user_id,
        period=period,
        amount=amount,
        currency=Currency.parse(currency),
        source=source,
        floor_amount=floor_amount,
        floor_source=floor_source,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )


def suggest_variable_base(monthly_incomes: Sequence[Decimal]) -> Decimal | None:
    """Suggest a conservative variable-income base from the income ledger (ADR-139).

    The research's headline variable-income rule (product-deliverable §2.1): the base
    is the **lower of** the trailing-12-month average (``Σ / 12``) and the lowest
    single month, so essentials are budgeted from a conservative floor and only
    better-than-base months feed the true-up. Pure and feed-free: the adapter
    supplies the trailing-12 monthly income totals; this applies the rule.

    Returns ``None`` when fewer than 12 months of history are supplied — the rule is
    not meaningful without a full year, so the UI degrades to a manual base
    (product-deliverable §5.7). The suggestion is offered for the user to accept into
    the manual field (suggest/confirm, ADR-044); it is never auto-applied.

    Args:
        monthly_incomes: The trailing-12-month per-month income totals (any order;
            most recent windows pass exactly 12 values).

    Returns:
        The suggested base rounded to cents, or ``None`` when there are fewer than
        12 months of history.
    """
    if len(monthly_incomes) < _MIN_MONTHS_FOR_VARIABLE_BASE:
        return None
    average = (sum(monthly_incomes, ZERO) / Decimal(len(monthly_incomes))).quantize(CENTS, rounding=ROUND_HALF_UP)
    return min(average, min(monthly_incomes))
