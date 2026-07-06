"""The ``Institution`` aggregate root (ADR-122, ADR-134).

An institution is the money holder a user names once: a bank, a card issuer,
physical cash, or a digital wallet (Deel / Payoneer / Mercado Pago). Like
:class:`Account` it is a plain Python aggregate — no Pydantic, no SQLAlchemy, no
I/O — that enforces its own invariants (ADR-031 lenient style). Its
currency-specific balances live on child :class:`Account` leaves (ADR-134); the
institution itself holds no balance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import (
    EmptyCardBrandError,
    EmptyNameError,
    InvalidCardLast4Error,
)
from margen_api.domain.models.value_objects import InstitutionType


@dataclass(eq=False)
class Institution:
    """A named money holder, the aggregate root and consistency boundary (ADR-134).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        name: Required human label (e.g. "Galicia", "Deel", "Cash"); trimmed and
            never empty (mirrors the transaction name invariant, ADR-024).
        type: The institution kind — bank / card / cash / wallet (ADR-134).
        brand: The card network label that, with ``last4``, identifies a physical
            card (e.g. "VISA", "Mastercard", "AMEX") (ADR-190). Free-text so new
            networks work without code changes. Optional — ``None`` for non-card
            institutions; when present it is trimmed and must be non-empty.
        last4: The four-digit printed suffix of the card, the other half of the card
            identity (ADR-190). Optional — ``None`` for non-card institutions; when
            present it must be exactly four decimal digits.
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every institution is attributable and every
            read can be scoped to its owner (ADR-130). A plain carried field, not a
            domain invariant; ``None`` only for legacy/unowned construction.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    name: str
    type: InstitutionType = InstitutionType.BANK
    brand: str | None = None
    last4: str | None = None
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.type = InstitutionType.parse(self.type)
        self._normalize()

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031)."""
        # Hard invariant: name is a required, non-empty display label (ADR-024 style).
        self.name = self.name.strip() if isinstance(self.name, str) else self.name
        if not self.name:
            raise EmptyNameError
        self._normalize_card_identity()

    def _normalize_card_identity(self) -> None:
        """Normalize the optional card identity and enforce its invariants (ADR-190).

        ``brand`` and ``last4`` are only present on CARD institutions; both stay
        ``None`` for bank / cash / wallet. When present, ``brand`` is trimmed and must
        be non-empty and ``last4`` must be exactly four decimal digits (ADR-031).
        """
        if self.brand is not None:
            self.brand = self.brand.strip() if isinstance(self.brand, str) else self.brand
            if not self.brand:
                raise EmptyCardBrandError
        if self.last4 is not None:
            self.last4 = self.last4.strip() if isinstance(self.last4, str) else self.last4
            if not (isinstance(self.last4, str) and len(self.last4) == 4 and self.last4.isdigit()):
                raise InvalidCardLast4Error(self.last4)


def build_institution(
    *,
    name: str,
    type: InstitutionType | str = InstitutionType.BANK,  # noqa: A002 — mirrors the field name
    brand: str | None = None,
    last4: str | None = None,
    user_id: str | None = None,
    institution_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Institution:
    """Construct a valid :class:`Institution`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience. The application handler injects ``id``, ``created_at`` and
    ``updated_at`` so the domain performs no implicit clock or UUID reads in
    production. Invariants run inside ``Institution.__post_init__``.

    Args:
        name: Required human label; trimmed and must be non-empty.
        type: Institution kind, as ``InstitutionType`` or string.
        brand: Optional card network label (e.g. "VISA"); trimmed and non-empty when
            present, ``None`` for non-card institutions (ADR-190).
        last4: Optional four-digit card suffix; exactly four digits when present,
            ``None`` for non-card institutions (ADR-190).
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-130).
        institution_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Institution`` aggregate.

    Raises:
        EmptyNameError: When ``name`` is empty or only whitespace.
        UnknownInstitutionTypeError: When ``type`` is not a known institution type.
        EmptyCardBrandError: When ``brand`` is present but blank (ADR-190).
        InvalidCardLast4Error: When ``last4`` is present but not four digits (ADR-190).
    """
    now = datetime.now(UTC)
    return Institution(
        id=institution_id if institution_id is not None else uuid4(),
        name=name,
        type=InstitutionType.parse(type),
        brand=brand,
        last4=last4,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
