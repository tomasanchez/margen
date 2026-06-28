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
