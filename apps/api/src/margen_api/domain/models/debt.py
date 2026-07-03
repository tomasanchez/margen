"""The ``Debt`` aggregate root (ADR-187, ADR-130, ADR-183).

A debt is a manual, balance-bearing liability the user maintains by hand: a personal
loan, an informal debt, or any fixed obligation not derived from transactions
(ADR-187). It is deliberately distinct from the transaction-derived liability legs —
instalment tails (ADR-181) and unpaid CC balances (ADR-185) — and from the ``Account``
aggregate, which carries transaction-derived asset balances (ADR-122). Like
:class:`Account` it is a plain Python aggregate — no Pydantic, no SQLAlchemy, no I/O —
that enforces its own invariants (ADR-031 lenient style) and carries its own native
currency (ADR-183). Its ``current_balance`` feeds the net-worth ``liabilities.other``
leg (ADR-187), never the assets ``total`` (ADR-186). ``monthly_minimum`` and ``rate``
are optional YAGNI extension points for a future minimum-payment / interest slice
(ADR-187); they carry no behaviour today.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import EmptyNameError, InvalidBalanceError
from margen_api.domain.models.value_objects import Currency

ZERO = Decimal("0")


@dataclass(eq=False)
class Debt:
    """A manual, balance-bearing liability, the aggregate root and consistency boundary (ADR-187).

    ``current_balance`` is the outstanding amount the user owes, stored in the debt's
    own ``currency`` (ADR-183): a USD debt's balance is USD-native, an ARS debt's is
    ARS. Unlike an :class:`Account` opening balance it may NOT be negative — a debt is a
    non-negative obligation (ADR-187). The user updates it by hand as the debt changes;
    there is no amortization schedule or lifecycle state (ADR-187).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        name: Required human label (e.g. "Banco Nación personal loan"); trimmed and
            never empty (mirrors the transaction/institution name invariant, ADR-024).
        currency: The debt's native currency, ARS or USD (ADR-183).
        current_balance: The outstanding amount owed, in the debt's native ``currency``;
            a non-negative magnitude (ADR-187). Feeds ``liabilities.other`` (ADR-187).
        monthly_minimum: Optional minimum monthly payment, in the debt's native
            ``currency``; a YAGNI extension point carrying no behaviour today (ADR-187).
        rate: Optional interest rate; a YAGNI extension point carrying no behaviour
            today (ADR-187).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every debt is attributable and every read can be
            scoped to its owner (ADR-130). A plain carried field, not a domain
            invariant; ``None`` only for legacy/unowned construction.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    name: str
    currency: Currency = Currency.ARS
    current_balance: Decimal = ZERO
    monthly_minimum: Decimal | None = None
    rate: Decimal | None = None
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.currency = Currency.parse(self.currency)
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031)."""
        # Hard invariant: name is a required, non-empty display label (ADR-024 style).
        self.name = self.name.strip() if isinstance(self.name, str) else self.name
        if not self.name:
            raise EmptyNameError
        # The balance is money (ADR-025): coerce to Decimal, then enforce the
        # non-negative invariant — a debt is a non-negative obligation (ADR-187).
        if not isinstance(self.current_balance, Decimal):
            self.current_balance = Decimal(str(self.current_balance))
        if self.current_balance < ZERO:
            raise InvalidBalanceError(self.current_balance)
        # Optional money fields (ADR-187): coerce to Decimal when present; ``None`` stays
        # ``None`` (unset). No positivity invariant — these are lenient extension points.
        if self.monthly_minimum is not None and not isinstance(self.monthly_minimum, Decimal):
            self.monthly_minimum = Decimal(str(self.monthly_minimum))
        if self.rate is not None and not isinstance(self.rate, Decimal):
            self.rate = Decimal(str(self.rate))


def build_debt(
    *,
    name: str,
    currency: Currency | str = Currency.ARS,
    current_balance: Decimal = ZERO,
    monthly_minimum: Decimal | None = None,
    rate: Decimal | None = None,
    user_id: str | None = None,
    debt_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Debt:
    """Construct a valid :class:`Debt`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a convenience.
    The application handler injects ``id``, ``created_at`` and ``updated_at`` so the
    domain performs no implicit clock or UUID reads in production (ADR-026). Invariants
    run inside ``Debt.__post_init__``.

    Args:
        name: Required human label; trimmed and must be non-empty.
        currency: ARS or USD, as ``Currency`` or string (ADR-183).
        current_balance: The non-negative native-currency outstanding amount; defaults
            to ``0`` (ADR-187).
        monthly_minimum: Optional minimum monthly payment; ``None`` when unset (ADR-187).
        rate: Optional interest rate; ``None`` when unset (ADR-187).
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        debt_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Debt`` aggregate.

    Raises:
        EmptyNameError: When ``name`` is empty or only whitespace.
        InvalidBalanceError: When ``current_balance`` is negative.
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    return Debt(
        id=debt_id if debt_id is not None else uuid4(),
        name=name,
        currency=Currency.parse(currency),
        current_balance=current_balance,
        monthly_minimum=monthly_minimum,
        rate=rate,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
