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
