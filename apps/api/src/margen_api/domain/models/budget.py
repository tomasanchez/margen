"""The ``Budget`` aggregate root (ADR-125).

A budget is a per-category monthly spending target: a user sets, for a calendar
month, how much they intend to spend in one expense category. The actuals it is
compared against are derived from the existing category summaries reader (ADR-042,
ADR-125), so the aggregate stores only the *target* — never the spend.

Like :class:`~margen_api.domain.models.account.Account` it is a plain Python
aggregate — no Pydantic, no SQLAlchemy, no I/O — that enforces its own invariants
(ADR-031 lenient style) and carries the per-user owner (ADR-130). The ``period`` is
normalized to the first day of its calendar month (the month-navigator period,
ADR-040), mirroring monotributo's ``month_start``, so ``(user_id, category, period)``
is one target per category per month (the upsert key, ADR-125). Money is
:class:`~decimal.Decimal` (ADR-025); for the MVP the target currency is ARS to match
the ARS-equivalent category actuals (ADR-125 currency note).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.value_objects import Currency

ZERO = Decimal("0")


def month_start(value: date) -> date:
    """Return the first day of ``value``'s calendar month (the budget period, ADR-040).

    A budget aligns to the month-navigator period (ADR-125), so any date within a
    month identifies that month's budget. Mirrors monotributo's ``month_start`` so
    every period-keyed feature shares one month identity.

    Args:
        value: Any date; only its year and month are significant.

    Returns:
        The first day of ``value``'s month.
    """
    return date(value.year, value.month, 1)


@dataclass(eq=False)
class Budget:
    """A per-category monthly spending target, the aggregate root (ADR-125).

    ``amount`` is the target the user intends to spend in ``category`` during the
    ``period`` month, stored in ``currency`` (ARS for the MVP, ADR-125 currency
    note). It is a positive money magnitude (ADR-025); the spend it is compared
    against is derived by the query side from the category summaries, never stored
    here (ADR-042, ADR-125).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every budget is attributable and every read can
            be scoped to its owner (ADR-130). A plain carried field; ``None`` only
            for legacy/unowned construction.
        category: The expense category the target applies to — a
            :data:`~margen_api.domain.models.value_objects.KNOWN_CATEGORIES` value
            (lenient: an unknown string is tolerated as-is, ADR-027).
        period: The budget month, normalized to the first day of the month
            (ADR-040), so a category has at most one target per month (ADR-125).
        amount: The target spend for the category in the month, a positive
            ARS-equivalent magnitude (ADR-025).
        currency: The target's currency; ARS for the MVP (ADR-125 currency note).
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    user_id: str | None
    category: str
    period: date
    amount: Decimal = ZERO
    currency: Currency = Currency.ARS
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.currency = Currency.parse(self.currency)
        self.period = month_start(self.period)
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031).

        The target is money (ADR-025): coerce to ``Decimal``. ``category`` is kept
        as-given (lenient, ADR-027). The period was already normalized to the first
        of the month in ``__post_init__``.
        """
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))


def build_budget(
    *,
    category: str,
    period: date,
    amount: Decimal = ZERO,
    currency: Currency | str = Currency.ARS,
    user_id: str | None = None,
    budget_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Budget:
    """Construct a valid :class:`Budget`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience. The application handler injects ``id``, ``created_at`` and
    ``updated_at`` so the domain performs no implicit clock or UUID reads in
    production. Invariants run inside ``Budget.__post_init__``.

    Args:
        category: The expense category the target applies to (ADR-027).
        period: Any date in the budget month; normalized to the first of the month.
        amount: The target spend; defaults to ``0``.
        currency: ARS (MVP) as ``Currency`` or string (ADR-125 currency note).
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        budget_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Budget`` aggregate.

    Raises:
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    return Budget(
        id=budget_id if budget_id is not None else uuid4(),
        user_id=user_id,
        category=category,
        period=period,
        amount=amount,
        currency=Currency.parse(currency),
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
