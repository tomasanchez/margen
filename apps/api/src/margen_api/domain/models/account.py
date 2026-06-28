"""The ``Account`` aggregate root (ADR-122, ADR-123, ADR-134).

An account is a per-currency leaf under an :class:`Institution` (ADR-134): a
single ARS or USD balance held at one institution. Like :class:`Transaction` it
is a plain Python aggregate — no Pydantic, no SQLAlchemy, no I/O — that enforces
its own invariants (ADR-031 lenient style) and carries the per-account native
currency (ADR-123). The display label and kind (bank / card / cash / wallet) live
on the owning institution, not the account (ADR-134). A balance is NOT a stored
field: it is derived as ``opening_balance + Σ(linked transaction signed deltas)``
by the query side (ADR-122), so the aggregate stays lean (ADR-028).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.value_objects import Currency

ZERO = Decimal("0")


@dataclass(eq=False)
class Account:
    """A per-currency money holder under an institution, the aggregate root (ADR-134).

    ``opening_balance`` is the balance before any recorded transaction, stored in
    the account's own ``currency`` (ADR-123): a USD account's opening balance and
    derived balance are USD-native, an ARS account's are ARS. An account always
    belongs to exactly one institution (``institution_id``), which supplies the
    display name and type (ADR-134).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        institution_id: The owning institution's UUID (ADR-134). A user's account
            must reference one of their own institutions (ownership check, ADR-130).
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
    institution_id: UUID
    currency: Currency = Currency.ARS
    opening_balance: Decimal = ZERO
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.currency = Currency.parse(self.currency)
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031)."""
        # The opening balance is money (ADR-025): coerce to Decimal. Unlike a
        # transaction amount it MAY be zero or negative (e.g. a card opened with
        # an outstanding balance), so no positivity invariant applies (ADR-122).
        if not isinstance(self.opening_balance, Decimal):
            self.opening_balance = Decimal(str(self.opening_balance))


def build_account(
    *,
    institution_id: UUID,
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
        institution_id: The owning institution's UUID (ADR-134).
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
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    return Account(
        id=account_id if account_id is not None else uuid4(),
        institution_id=institution_id,
        currency=Currency.parse(currency),
        opening_balance=opening_balance,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
