"""The ``Transaction`` aggregate root.

A transaction is the first real domain object in this service (ADR-028). It is a
plain Python aggregate — no Pydantic, no SQLAlchemy, no I/O — that enforces its
own invariants (ADR-031) and derives presentational fields such as ``type`` from
the persisted source of truth ``kind`` (ADR-027).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID, uuid4

from margen_api.domain.models.exceptions import EmptyNameError, InvalidAmountError
from margen_api.domain.models.value_objects import (
    Currency,
    FxRateType,
    Kind,
    TxType,
)

ZERO = Decimal("0")
CENTS = Decimal("0.01")


def materialize_usd_amount(amount: Decimal, fx_rate: Decimal) -> Decimal:
    """Materialize the USD equivalent from an ARS amount and an FX rate (ADR-148, ADR-149).

    Pure Decimal arithmetic — no I/O, no FX feed (ADR-149): ``round(amount ÷ fx_rate, 2)``
    with banker-free :data:`~decimal.ROUND_HALF_UP` to ``NUMERIC(18,2)`` precision
    (ADR-025). ``fx_rate`` is ARS per 1 USD; the caller guarantees it is positive.

    Args:
        amount: The authoritative ARS-equivalent magnitude (ADR-025).
        fx_rate: The ARS-per-1-USD rate the client supplied (ADR-149); must be > 0.

    Returns:
        The materialized USD amount rounded half-up to two decimal places.
    """
    return (amount / fx_rate).quantize(CENTS, rounding=ROUND_HALF_UP)


@dataclass(eq=False)
class Transaction:
    """A single money movement, the aggregate root and consistency boundary.

    ``amount`` is ALWAYS the positive ARS-equivalent magnitude (ADR-025); the
    visible sign is derived from :attr:`type`. ``kind`` is the persisted source of
    truth and ``type`` is derived from it (ADR-027). For USD rows, ``usd_amount``
    and ``fx_rate`` carry the original figure and the rate used to convert it —
    but a USD row missing its rate is accepted as incomplete, never rejected
    (ADR-031).

    Attributes:
        id: Stable UUID identity, safe to expose in URLs (ADR-026).
        occurred_on: Real calendar date the movement happened; backdating allowed.
        name: Required human label shown everywhere (e.g. "Coto supermarket",
            "Apartment rent"); trimmed and never empty (ADR-024).
        kind: Persisted money kind (expense / income / invoice).
        amount: Positive ARS-equivalent magnitude.
        currency: ARS (base) or USD.
        usd_amount: Materialized USD equivalent for USD rows, else ``None``. When a
            positive ``fx_rate`` is present it is recomputed as
            ``round(amount ÷ fx_rate, 2)`` (ADR-148, ADR-149) so the stored figure
            always round-trips from the authoritative ``amount``.
        fx_rate: Rate used for the USD to ARS conversion (ARS per 1 USD), else
            ``None``.
        fx_source: Provenance of the FX snapshot rate the client supplied (e.g.
            ``'bolsa'``, ``'mep'``, ``'oficial'``, ``'manual'``, ``'backfill'``),
            else ``None`` (ADR-148). Distinct from ``fx_rate_type``: the snapshot
            source is the per-row capture provenance (ADR-149), kept null until a
            snapshot is set.
        fx_rate_type: Rate family (defaults to MEP for USD rows), else ``None``.
        fx_rate_as_of: Timestamp the rate was observed, else ``None``.
        category: Validated category string, optional (ADR-027).
        payment_method: Normalized bank / channel label, optional (ADR-117).
        card: Optional card / detail label for display (e.g. ``"VISA ·5771"``,
            ``"AMEX ·1234"``); ``None`` when there is no card (ADR-117).
        notes: Free-form optional note, distinct from :attr:`name` (ADR-024).
        recurring: Whether the movement repeats.
        counts_toward_monotributo: Only meaningful for income / invoice; forced
            ``False`` for expense (ADR-027, ADR-031).
        statement_document_id: Optional link back to the source statement document
            for an imported credit-card expense (ADR-077). A plain carried field,
            not a domain invariant — the aggregate stays lean (ADR-028); ``None``
            for manually-entered transactions.
        account_id: Optional link to the owning account this movement belongs to
            (ADR-122). A plain carried field, not a domain invariant; ``None`` for
            transactions not yet attributed to an account. The owning-account
            check (a user may only link to their own account) is an application-layer
            concern (ADR-130), not a domain invariant.
        user_id: The owning user's id (the Supabase ``sub``), threaded from the
            authenticated request so every write is attributable and every read
            can be scoped to its owner (ADR-094, ADR-108). A plain carried field,
            not a domain invariant; ``None`` for legacy rows predating ownership.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    occurred_on: date
    name: str
    kind: Kind
    amount: Decimal
    currency: Currency = Currency.ARS
    usd_amount: Decimal | None = None
    fx_rate: Decimal | None = None
    fx_source: str | None = None
    fx_rate_type: FxRateType | None = None
    fx_rate_as_of: datetime | None = None
    category: str | None = None
    payment_method: str | None = None
    card: str | None = None
    notes: str | None = None
    recurring: bool = False
    counts_toward_monotributo: bool = False
    statement_document_id: UUID | None = None
    account_id: UUID | None = None
    user_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        """Normalize and enforce invariants on construction."""
        self.kind = Kind.parse(self.kind)
        self.currency = Currency.parse(self.currency)
        self._normalize()

    @property
    def type(self) -> TxType:
        """Derive the high-level direction from :attr:`kind` (ADR-027).

        Returns:
            ``TxType.EXPENSE`` when kind is expense, otherwise ``TxType.INCOME``.
        """
        return TxType.EXPENSE if self.kind is Kind.EXPENSE else TxType.INCOME

    def _normalize(self) -> None:
        """Apply lenient normalization and enforce hard invariants (ADR-031)."""
        # Hard invariant: name is a required, non-empty display label (ADR-024).
        self.name = self.name.strip() if isinstance(self.name, str) else self.name
        if not self.name:
            raise EmptyNameError

        # Hard invariant: amount is a positive ARS-equivalent magnitude.
        if not isinstance(self.amount, Decimal):
            self.amount = Decimal(str(self.amount))
        if self.amount <= ZERO:
            raise InvalidAmountError(self.amount)

        # Monotributo counting only applies to income / invoice; force False for expense.
        if self.kind is Kind.EXPENSE:
            self.counts_toward_monotributo = False

        self._normalize_fx()

    def _normalize_fx(self) -> None:
        """Normalize the FX snapshot block on construction (ADR-148, ADR-149, ADR-152).

        A client-supplied FX snapshot (a non-null ``fx_source``) applies to ANY row
        regardless of currency: ARS expenses — the bulk of spend — are converted to
        USD via the snapshot, and USD rows snapshot just the same. When the snapshot
        carries a positive rate the server materializes the USD figure from the
        authoritative amount (``round(amount ÷ fx_rate, 2)``) rather than trusting a
        client-supplied ``usd_amount``, keeping the stored snapshot a faithful
        round-trip. With NO snapshot, the legacy ADR-029 USD flow stands untouched and
        an ARS row's FX metadata is dropped rather than rejected (ADR-031).
        """
        if self.fx_rate is not None and not isinstance(self.fx_rate, Decimal):
            self.fx_rate = Decimal(str(self.fx_rate))

        if self.fx_source is not None:
            if self.fx_rate_type is None:
                self.fx_rate_type = FxRateType.MEP
            if self.fx_rate is not None and self.fx_rate > ZERO:
                self.usd_amount = materialize_usd_amount(self.amount, self.fx_rate)
        elif self.currency is Currency.USD:
            # No snapshot: USD rows default to the MEP rate family; usd_amount / fx_rate
            # may carry the legacy figure or be absent (amount stays authoritative).
            if self.fx_rate_type is None:
                self.fx_rate_type = FxRateType.MEP
        else:
            # An ARS row with NO snapshot must not carry FX metadata; drop it.
            self.usd_amount = None
            self.fx_rate = None
            self.fx_rate_type = None
            self.fx_rate_as_of = None

    @property
    def has_complete_fx(self) -> bool:
        """Return whether a USD row carries both its USD amount and FX rate.

        A USD row without a rate is valid-but-incomplete (ADR-031); FX work (#7)
        may enrich it later.
        """
        return self.currency is Currency.USD and self.usd_amount is not None and self.fx_rate is not None


def build_transaction(
    *,
    occurred_on: date,
    name: str,
    kind: Kind | str,
    amount: Decimal,
    currency: Currency | str = Currency.ARS,
    usd_amount: Decimal | None = None,
    fx_rate: Decimal | None = None,
    fx_source: str | None = None,
    fx_rate_type: FxRateType | str | None = None,
    fx_rate_as_of: datetime | None = None,
    category: str | None = None,
    payment_method: str | None = None,
    card: str | None = None,
    notes: str | None = None,
    recurring: bool = False,
    counts_toward_monotributo: bool = False,
    statement_document_id: UUID | None = None,
    account_id: UUID | None = None,
    user_id: str | None = None,
    transaction_id: UUID | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Transaction:
    """Construct a valid :class:`Transaction`, generating identity and timestamps.

    The domain stays pure: identity and timestamps default here only as a
    convenience. The application handler is expected to inject ``id``,
    ``created_at`` and ``updated_at`` so the domain performs no implicit clock or
    UUID reads in production. Invariants run inside ``Transaction.__post_init__``.

    Args:
        occurred_on: Real calendar date of the movement.
        name: Required human label; trimmed and must be non-empty (ADR-024).
        kind: Money kind, as ``Kind`` or string.
        amount: Positive ARS-equivalent magnitude.
        currency: ARS or USD, as ``Currency`` or string.
        usd_amount: Original USD amount for USD rows; re-materialized from
            ``amount ÷ fx_rate`` when a positive rate is supplied (ADR-148/149).
        fx_rate: Conversion rate for USD rows (ARS per 1 USD).
        fx_source: Provenance of the FX snapshot rate the client supplied (ADR-148).
        fx_rate_type: Rate family; defaults to MEP for USD rows when omitted.
        fx_rate_as_of: Timestamp the rate was observed.
        category: Optional category string.
        payment_method: Optional normalized bank / channel label (ADR-117).
        card: Optional card / detail label for display (ADR-117).
        notes: Optional free-form note.
        recurring: Whether the movement repeats.
        counts_toward_monotributo: Monotributo counting hint (income / invoice only).
        statement_document_id: Optional link to the source statement document for
            an imported credit-card expense (ADR-077); ``None`` otherwise.
        account_id: Optional link to the owning account (ADR-122); ``None`` otherwise.
        user_id: The owning user's id (the Supabase ``sub``); ``None`` otherwise
            (ADR-094, ADR-108).
        transaction_id: Optional identity; generated when omitted.
        created_at: Optional creation timestamp; defaults to now (UTC).
        updated_at: Optional update timestamp; defaults to now (UTC).

    Returns:
        A validated, normalized ``Transaction`` aggregate.

    Raises:
        EmptyNameError: When ``name`` is empty or only whitespace.
        InvalidAmountError: When ``amount`` is not a positive magnitude.
        UnknownKindError: When ``kind`` is not a known kind.
        UnknownCurrencyError: When ``currency`` is not a known currency.
    """
    now = datetime.now(UTC)
    resolved_fx_rate_type = FxRateType(fx_rate_type) if isinstance(fx_rate_type, str) else fx_rate_type
    return Transaction(
        id=transaction_id if transaction_id is not None else uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.parse(kind),
        amount=amount,
        currency=Currency.parse(currency),
        usd_amount=usd_amount,
        fx_rate=fx_rate,
        fx_source=fx_source,
        fx_rate_type=resolved_fx_rate_type,
        fx_rate_as_of=fx_rate_as_of,
        category=category,
        payment_method=payment_method,
        card=card,
        notes=notes,
        recurring=recurring,
        counts_toward_monotributo=counts_toward_monotributo,
        statement_document_id=statement_document_id,
        account_id=account_id,
        user_id=user_id,
        created_at=created_at if created_at is not None else now,
        updated_at=updated_at if updated_at is not None else now,
    )
