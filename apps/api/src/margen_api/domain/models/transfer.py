"""The ``Transfer`` aggregate root (ADR-135).

A transfer is an internal money movement between two of the user's own accounts —
NOT income or expense and NOT a :class:`Transaction` (ADR-135). It is a plain
Python aggregate — no Pydantic, no SQLAlchemy, no I/O — that enforces its own
invariants (ADR-031 lenient style) and carries the per-account native amounts
(ADR-123). Net worth is conserved across a same-currency transfer
(``amount_out == amount_in``); a cross-currency transfer differs because the user
records the actual amount received (ADR-135). Fees are NOT modeled here: each fee
is a separate ``kind=expense`` transaction in the "Fees" category (ADR-135).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import InvalidAmountError, SameAccountTransferError

ZERO = Decimal("0")


@dataclass(eq=False)
class Transfer:
    """A money movement between two of the owner's accounts, the aggregate root (ADR-135).

    ``amount_out`` is debited from the source account in its native currency and
    ``amount_in`` is credited to the destination account in its native currency
    (ADR-123). Both are positive magnitudes (ADR-025). For a same-currency transfer
    the caller passes ``amount_out == amount_in`` (truly net-zero); a cross-currency
    transfer differs, so equality is NOT enforced (ADR-135). The two accounts must
    differ; the owning-account check (both belong to the caller) is an
    application-layer concern (ADR-130), not a domain invariant.

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        from_account_id: The source account's UUID; money is debited from it.
        to_account_id: The destination account's UUID; money is credited to it.
        amount_out: Positive magnitude debited from the source, in the source
            account's native currency (ADR-123, ADR-025).
        amount_in: Positive magnitude credited to the destination, in the
            destination account's native currency (ADR-123, ADR-025).
        occurred_on: Real calendar date the transfer happened; backdating allowed.
        note: Free-form optional note (ADR-024 style).
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every transfer is attributable and every read
            can be scoped to its owner (ADR-130). A plain carried field, not a
            domain invariant; ``None`` only for legacy/unowned construction.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    from_account_id: UUID
    to_account_id: UUID
    amount_out: Decimal
    amount_in: Decimal
    occurred_on: date
    note: str | None = None
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031, ADR-135)."""
        # Hard invariant: a transfer moves money between two DIFFERENT accounts.
        if self.from_account_id == self.to_account_id:
            raise SameAccountTransferError(self.from_account_id)

        # Hard invariant: both legs are positive money magnitudes (ADR-025). Unlike
        # an account opening balance they may never be zero or negative — a transfer
        # of nothing is meaningless. Equality of the two legs is NOT enforced: a
        # cross-currency transfer differs by design (ADR-135).
        if not isinstance(self.amount_out, Decimal):
            self.amount_out = Decimal(str(self.amount_out))
        if self.amount_out <= ZERO:
            raise InvalidAmountError(self.amount_out)
        if not isinstance(self.amount_in, Decimal):
            self.amount_in = Decimal(str(self.amount_in))
        if self.amount_in <= ZERO:
            raise InvalidAmountError(self.amount_in)

        # ``note`` is an optional free-form label; trim it, treating blank as absent.
        if isinstance(self.note, str):
            self.note = self.note.strip() or None


def build_transfer(
    *,
    from_account_id: UUID,
    to_account_id: UUID,
    amount_out: Decimal,
    amount_in: Decimal,
    occurred_on: date,
    note: str | None = None,
    user_id: str | None = None,
    transfer_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Transfer:
    """Construct a valid :class:`Transfer`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience. The application handler injects ``id``, ``created_at`` and
    ``updated_at`` so the domain performs no implicit clock or UUID reads in
    production. Invariants run inside ``Transfer.__post_init__``.

    Args:
        from_account_id: The source account's UUID; money is debited from it.
        to_account_id: The destination account's UUID; money is credited to it.
        amount_out: Positive magnitude debited from the source, source-native.
        amount_in: Positive magnitude credited to the destination, dest-native.
        occurred_on: Real calendar date of the transfer.
        note: Optional free-form note.
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        transfer_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Transfer`` aggregate.

    Raises:
        SameAccountTransferError: When the source and destination accounts match.
        InvalidAmountError: When either leg is not a positive magnitude.
    """
    now = datetime.now(UTC)
    return Transfer(
        id=transfer_id if transfer_id is not None else uuid4(),
        from_account_id=from_account_id,
        to_account_id=to_account_id,
        amount_out=amount_out,
        amount_in=amount_in,
        occurred_on=occurred_on,
        note=note,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
