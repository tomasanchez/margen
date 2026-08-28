"""Domain exceptions for the transaction aggregate.

These signal true invariant violations (ADR-031). Lenient edge cases such as a
USD row missing its FX rate are accepted as incomplete and do NOT raise.
"""


class TransactionError(Exception):
    """Base class for transaction domain invariant violations."""


class InvalidAmountError(TransactionError):
    """Raised when an amount is not a positive ARS-equivalent magnitude.

    The ARS-equivalent ``amount`` is authoritative and always positive; sign is
    presentational and derives from ``kind``/``type`` (ADR-025, ADR-031).
    """

    def __init__(self, amount: object) -> None:
        self.amount = amount
        super().__init__(f"amount must be a positive ARS-equivalent magnitude, got {amount!r}")


class EmptyNameError(TransactionError):
    """Raised when a transaction is built without a non-empty display name.

    ``name`` is the required human label shown everywhere in the UI (ADR-024);
    an empty or whitespace-only value is a true invariant violation.
    """

    def __init__(self) -> None:
        super().__init__("name must be a non-empty display label")


class InvalidInstallmentError(TransactionError):
    """Raised when an instalment index/total pair is inconsistent (ADR-174).

    An instalment marker is ``N/M`` — the ``N``-th of ``M`` payments — so both figures
    must be positive and ``N`` may not exceed ``M`` (ADR-174). Any other combination is
    a true invariant violation the boundary maps to ``422`` (ADR-031). Absent (both
    ``None``) is fine — the fields are optional; the mismatch only fires when at least
    one is present and the pair is invalid. The carried ``index``/``total`` let the
    entrypoint build a meaningful message.
    """

    def __init__(self, index: object, total: object) -> None:
        self.index = index
        self.total = total
        super().__init__(
            f"invalid instalment marker: index {index!r} of total {total!r} "
            "(both must be positive and index must not exceed total)"
        )


class UnknownKindError(TransactionError):
    """Raised when a transaction kind is not one of the known kinds."""

    def __init__(self, kind: object) -> None:
        self.kind = kind
        super().__init__(f"unknown transaction kind: {kind!r}")


class UnknownCurrencyError(TransactionError):
    """Raised when a transaction currency is not one of the known currencies."""

    def __init__(self, currency: object) -> None:
        self.currency = currency
        super().__init__(f"unknown currency: {currency!r}")


class TransactionNotFoundError(TransactionError):
    """Raised when no transaction matches a referenced identity.

    Update and delete handlers raise this when the aggregate they target does
    not exist, so the boundary can translate it into a 404 (ADR-030). The
    carried ``transaction_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, transaction_id: object) -> None:
        self.transaction_id = transaction_id
        super().__init__(f"transaction not found: {transaction_id!r}")


class UnknownInstitutionTypeError(TransactionError):
    """Raised when an institution type is not one of the known types (ADR-122, ADR-134)."""

    def __init__(self, institution_type: object) -> None:
        self.institution_type = institution_type
        super().__init__(f"unknown institution type: {institution_type!r}")


class UnknownBudgetKindError(TransactionError):
    """Raised when a budget kind is not one of the known kinds (ADR-138).

    A budget row is either a spend target or a saving allocation; any other value
    is a true invariant violation the boundary maps to ``422`` (ADR-031). The
    carried ``kind`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, kind: object) -> None:
        self.kind = kind
        super().__init__(f"unknown budget kind: {kind!r} (expected one of spend, saving)")


class MissingIncomeBaseError(TransactionError):
    """Raised when applying a saving profile without a net-income base (ADR-138).

    Saving allocations are a percentage of the month's net spendable income, so a
    profile cannot be applied for a month with no :class:`BudgetIncome` base. The
    boundary maps this to ``409 Conflict`` so the client can prompt the user to set
    their income first. The carried ``period`` lets the entrypoint build a message.
    """

    def __init__(self, period: object) -> None:
        self.period = period
        super().__init__(f"a net-income base must be set before applying a saving profile for {period!r}")


class UnknownSavingProfileError(TransactionError):
    """Raised when a saving profile is not one of the known presets (ADR-138).

    The closed ``{conservative, balanced, aggressive}`` set; any other value is a
    true invariant violation the boundary maps to ``422`` (ADR-031). The carried
    ``profile`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, profile: object) -> None:
        self.profile = profile
        super().__init__(f"unknown saving profile: {profile!r} (expected one of conservative, balanced, aggressive)")


class AccountNotFoundError(TransactionError):
    """Raised when no account matches a referenced identity (ADR-122, ADR-130).

    Update handlers raise this when the aggregate they target does not exist for
    the owner, so the boundary can translate it into a 404 (ADR-111). The carried
    ``account_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, account_id: object) -> None:
        self.account_id = account_id
        super().__init__(f"account not found: {account_id!r}")


class InstitutionNotFoundError(TransactionError):
    """Raised when no institution matches a referenced identity (ADR-130, ADR-134).

    Update handlers raise this when the institution they target does not exist for
    the owner, and the account create/update handlers raise it when a linked
    ``institution_id`` is not one of the caller's institutions, so the boundary can
    translate it into a 404 (ADR-111). The carried ``institution_id`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, institution_id: object) -> None:
        self.institution_id = institution_id
        super().__init__(f"institution not found: {institution_id!r}")


class InvalidCardLast4Error(TransactionError):
    """Raised when a card's ``last4`` is present but not exactly four digits (ADR-190).

    ``last4`` identifies a physical card together with ``brand`` (ADR-190). It is
    optional — only card institutions carry it — but when present it must be exactly
    four decimal digits (the printed suffix). Any other value is a true invariant
    violation the boundary maps to ``422`` (ADR-031). The carried ``last4`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, last4: object) -> None:
        self.last4 = last4
        super().__init__(f"card last4 must be exactly four digits when present, got {last4!r}")


class EmptyCardBrandError(TransactionError):
    """Raised when a card's ``brand`` is present but blank (ADR-190).

    ``brand`` is the free-text card network label (e.g. "VISA", "Mastercard",
    "AMEX") that identifies a card together with ``last4`` (ADR-190). It is optional,
    but a whitespace-only value carries no identity and is a true invariant violation
    the boundary maps to ``422`` (ADR-031).
    """

    def __init__(self) -> None:
        super().__init__("card brand must be a non-empty label when present")


class SameAccountTransferError(TransactionError):
    """Raised when a transfer's source and destination accounts are the same (ADR-135).

    A transfer moves money between two DIFFERENT accounts; pointing both legs at one
    account is a true invariant violation, which the boundary maps to 422 (ADR-031).
    The carried ``account_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, account_id: object) -> None:
        self.account_id = account_id
        super().__init__(f"a transfer must move money between two different accounts, got {account_id!r} twice")


class TransferNotFoundError(TransactionError):
    """Raised when no transfer matches a referenced identity (ADR-135, ADR-130).

    Delete handlers raise this when the aggregate they target does not exist for the
    owner, so the boundary can translate it into a 404 (ADR-111). The carried
    ``transfer_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, transfer_id: object) -> None:
        self.transfer_id = transfer_id
        super().__init__(f"transfer not found: {transfer_id!r}")


class OffsetTargetNotFoundError(TransactionError):
    """Raised when a reimbursement's offset target is missing or not owned (ADR-159, ADR-130).

    The create handler raises this when a ``kind='reimbursement'`` command links an
    ``offsets_transaction_id`` that does not exist for the caller — either no such
    row or one owned by another user (a cross-owner link, ADR-159). Mirrors the
    account-ownership guard (ADR-130); the boundary maps it to a ``404`` (ADR-111).
    The carried ``transaction_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, transaction_id: object) -> None:
        self.transaction_id = transaction_id
        super().__init__(f"offset target transaction not found: {transaction_id!r}")


class OffsetTargetNotExpenseError(TransactionError):
    """Raised when a reimbursement links an offset target that is not an EXPENSE (ADR-159).

    A payback may only offset an EXPENSE (ADR-159); linking it to an income, invoice
    or another reimbursement is a true invariant violation the boundary maps to
    ``422`` (ADR-031). The carried ``transaction_id`` and ``kind`` let the entrypoint
    build a meaningful message.
    """

    def __init__(self, transaction_id: object, kind: object) -> None:
        self.transaction_id = transaction_id
        self.kind = kind
        super().__init__(
            f"offset target {transaction_id!r} is a {kind!r}, but a reimbursement may only offset an expense"
        )


class InvalidBalanceError(TransactionError):
    """Raised when a debt is built with a negative current balance (ADR-187).

    A :class:`~margen_api.domain.models.debt.Debt` tracks an outstanding amount the
    user owes; that balance is a non-negative magnitude (``>= 0``). A negative value
    is a true invariant violation the boundary maps to ``422`` (ADR-031). The carried
    ``balance`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, balance: object) -> None:
        self.balance = balance
        super().__init__(f"current balance must be a non-negative magnitude, got {balance!r}")


class DebtNotFoundError(TransactionError):
    """Raised when no debt matches a referenced identity (ADR-187, ADR-130).

    Update and delete handlers raise this when the debt they target does not exist
    for the owner, so the boundary can translate it into a 404 (ADR-111). The carried
    ``debt_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, debt_id: object) -> None:
        self.debt_id = debt_id
        super().__init__(f"debt not found: {debt_id!r}")


class UnknownPaymentSourceError(TransactionError):
    """Raised when a receivable payment source is not one of the known sources (ADR-204, ADR-207).

    A :class:`~margen_api.domain.models.receivable.ReceivablePayment` originates either
    from a manually recorded payback (``manual``) or from a confirmed income match
    (``matched_income``, ADR-207). Any other value is a true invariant violation the
    boundary maps to ``422`` (ADR-031). The carried ``source`` lets the entrypoint build
    a meaningful message.
    """

    def __init__(self, source: object) -> None:
        self.source = source
        super().__init__(f"unknown receivable payment source: {source!r} (expected one of manual, matched_income)")


class PersonNotFoundError(TransactionError):
    """Raised when no person matches a referenced identity for the owner (ADR-204, ADR-130).

    The rename/delete-person, add-item and record-payment handlers raise this when the
    :class:`~margen_api.domain.models.receivable.Person` they target does not exist for
    the owner — either no such row or one owned by another user (a cross-owner reach,
    ADR-130). Mirrors :class:`DebtNotFoundError`; the boundary maps it to a ``404``
    (ADR-111). The carried ``person_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, person_id: object) -> None:
        self.person_id = person_id
        super().__init__(f"person not found: {person_id!r}")


class ReceivableItemNotFoundError(TransactionError):
    """Raised when no receivable item matches a referenced identity for the owner (ADR-204, ADR-130).

    The edit/delete-item handlers raise this when the
    :class:`~margen_api.domain.models.receivable.ReceivableItem` they target does not
    exist for the owner (scoped through its person's ``user_id``), and the record-payment
    handler raises it when an allocation references an item that is not one of the paying
    person's items (ADR-206). The boundary maps it to a ``404`` (ADR-111). The carried
    ``item_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, item_id: object) -> None:
        self.item_id = item_id
        super().__init__(f"receivable item not found: {item_id!r}")


class AllocationExceedsPaymentError(TransactionError):
    """Raised when a payment's allocations sum to more than the payment itself (ADR-206).

    A :class:`~margen_api.domain.models.receivable.ReceivablePayment` can only be applied
    to items up to its own ``amount`` — allocating more money than was received is a true
    invariant violation (not the overpayment *warning*, which is about the person's
    outstanding balance). The boundary maps it to a ``422`` (ADR-031). The carried
    ``payment_amount`` and ``allocated`` totals let the entrypoint build a meaningful
    message.
    """

    def __init__(self, payment_amount: object, allocated: object) -> None:
        self.payment_amount = payment_amount
        self.allocated = allocated
        super().__init__(f"payment allocations total {allocated!r} but the payment is only {payment_amount!r}")


class ReceivableOverpaymentError(TransactionError):
    """Raised when a payment would allocate more than a person currently owes (ADR-206).

    ADR-206's overpayment guard: when the total allocated to a person would exceed that
    person's current outstanding balance, the system MUST NOT silently clamp the amount
    nor silently drive the outstanding negative. The record-payment handler raises this so
    the API layer can surface a **confirm-time warning**; the caller may then retry with
    ``allow_overpayment=True`` to record a genuine good-faith credit (which drives the
    outstanding negative on purpose). The carried ``outstanding`` and ``requested`` totals
    let the boundary build the warning payload the UI confirms against.
    """

    def __init__(self, person_id: object, outstanding: object, requested: object) -> None:
        self.person_id = person_id
        self.outstanding = outstanding
        self.requested = requested
        super().__init__(
            f"payment for person {person_id!r} allocates {requested!r} but only {outstanding!r} is outstanding"
        )


class MatchedIncomeNotFoundError(TransactionError):
    """Raised when a confirm-match links an income that is missing, foreign or not income (ADR-207).

    The record-payment handler raises this when a ``matched_income_transaction_id`` supplied
    by the confirm-match flow (ADR-207) does not resolve to a usable income for the caller —
    either no such transaction, one owned by another user (a cross-owner reach, ADR-130), or
    one whose ``kind`` is not ``income``. All three collapse to a single not-found so the
    boundary answers ``404`` without leaking which case applies (existence never leaked,
    ADR-111). Mirrors :class:`OffsetTargetNotFoundError`; the carried ``transaction_id`` lets
    the entrypoint build a meaningful message.
    """

    def __init__(self, transaction_id: object) -> None:
        self.transaction_id = transaction_id
        super().__init__(f"matched income transaction not found: {transaction_id!r}")


class IncomeAlreadyClaimedError(TransactionError):
    """Raised when a confirm-match links an income already settled onto a payment (ADR-207).

    A confirmed income is "claimed": once it backs a ``receivable_payment`` it must not be
    re-used to settle a second debt, or one real income would settle two (ADR-207). The
    claimed invariant was previously enforced only in the suggestion reader; the record-
    payment handler now re-checks it inside the write transaction so two people matching the
    same income cannot both confirm it. The boundary maps this to ``409 Conflict``. The
    carried ``transaction_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, transaction_id: object) -> None:
        self.transaction_id = transaction_id
        super().__init__(f"income transaction already claimed by a receivable payment: {transaction_id!r}")


class MergeTargetNotFoundError(TransactionError):
    """Raised when a ``MERGE`` import line points at a missing transaction (ADR-085).

    The import handler raises this when a per-line ``merge`` resolution names a
    ``match_transaction_id`` that no longer exists, so the boundary can translate it
    into a ``409`` (the referenced manual expense was concurrently deleted). The
    carried ``transaction_id`` lets the entrypoint build a meaningful message.
    """

    def __init__(self, transaction_id: object) -> None:
        self.transaction_id = transaction_id
        super().__init__(f"merge target transaction not found: {transaction_id!r}")
