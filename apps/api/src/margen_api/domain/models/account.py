"""The ``Account`` aggregate root (ADR-122, ADR-123).

An account is a first-class money holder in the net-worth model: a bank account,
a cash wallet, or a credit-card account. Like :class:`Transaction` it is a plain
Python aggregate — no Pydantic, no SQLAlchemy, no I/O — that enforces its own
invariants (ADR-031 lenient style) and carries the per-account native currency
(ADR-123). A balance is NOT a stored field: it is derived as
``opening_balance + Σ(linked transaction signed deltas)`` by the query side
(ADR-122), so the aggregate stays lean (ADR-028).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import EmptyNameError
from margen_api.domain.models.value_objects import AccountType, Currency

ZERO = Decimal("0")


@dataclass(eq=False)
class Account:
    """A money-holding account, the aggregate root and consistency boundary.

    ``opening_balance`` is the balance before any recorded transaction, stored in
    the account's own ``currency`` (ADR-123): a USD account's opening balance and
    derived balance are USD-native, an ARS account's are ARS. The seeded-from-bank
    migration sets it to ``0`` so each account's net balance equals the sum of its
    existing transactions (ADR-124).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        name: Required human label (e.g. "Galicia", "Cash ARS"); trimmed and never
            empty (mirrors the transaction name invariant, ADR-024).
        type: The account kind — bank / cash / card (ADR-122).
        currency: The account's native currency, ARS or USD (ADR-123).
        opening_balance: The balance before any recorded transaction, in the
            account's native ``currency``; may be negative for a card account that
            opened with an outstanding balance (ADR-122).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every account is attributable and every read
            can be scoped to its owner (ADR-130). A plain carried field, not a
            domain invariant; ``None`` only for legacy/unowned construction.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    name: str
    type: AccountType
    currency: Currency = Currency.ARS
    opening_balance: Decimal = ZERO
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.type = AccountType.parse(self.type)
        self.currency = Currency.parse(self.currency)
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031)."""
        # Hard invariant: name is a required, non-empty display label (ADR-024 style).
        self.name = self.name.strip() if isinstance(self.name, str) else self.name
        if not self.name:
            raise EmptyNameError

        # The opening balance is money (ADR-025): coerce to Decimal. Unlike a
        # transaction amount it MAY be zero or negative (e.g. a card opened with
        # an outstanding balance), so no positivity invariant applies (ADR-122).
        if not isinstance(self.opening_balance, Decimal):
            self.opening_balance = Decimal(str(self.opening_balance))


def build_account(
    *,
    name: str,
    type: AccountType | str,  # noqa: A002 — mirrors the aggregate field name
    currency: Currency | str = Currency.ARS,
    opening_balance: Decimal = ZERO,
    user_id: str | None = None,
    account_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Account:
    """Construct a valid :class:`Account`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience. The application handler injects ``id``, ``created_at`` and
    ``updated_at`` so the domain performs no implicit clock or UUID reads in
    production. Invariants run inside ``Account.__post_init__``.

    Args:
        name: Required human label; trimmed and must be non-empty.
        type: Account kind, as ``AccountType`` or string.
        currency: ARS or USD, as ``Currency`` or string (ADR-123).
        opening_balance: The native-currency opening balance; defaults to ``0``.
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        account_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Account`` aggregate.

    Raises:
        EmptyNameError: When ``name`` is empty or only whitespace.
        UnknownAccountTypeError: When ``type`` is not a known account type.
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    return Account(
        id=account_id if account_id is not None else uuid4(),
        name=name,
        type=AccountType.parse(type),
        currency=Currency.parse(currency),
        opening_balance=opening_balance,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
