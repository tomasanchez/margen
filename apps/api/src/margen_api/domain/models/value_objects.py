"""Value objects for the transaction aggregate.

``Kind`` and ``Currency`` are closed enums — unknown members are domain errors.
``Category`` and ``PaymentMethod`` mirror the prototype's known set (ADR-027) but
stay tolerant of values outside it: #6 (categories) may rename or extend the
taxonomy without invalidating stored rows, so an unknown string is accepted as-is
rather than rejected.
"""

from __future__ import annotations

from enum import StrEnum

from margen_api.domain.models.exceptions import (
    UnknownCurrencyError,
    UnknownInstitutionTypeError,
    UnknownKindError,
)


class Kind(StrEnum):
    """Finer-grained money direction; the persisted source of truth (ADR-027).

    ``invoice`` is income that may count toward the Monotributo annual limit;
    ``income`` is other inflow (e.g. a refund modeled as positive income).
    """

    EXPENSE = "expense"
    INCOME = "income"
    INVOICE = "invoice"

    @classmethod
    def parse(cls, value: object) -> Kind:
        """Coerce a value to a ``Kind`` or raise ``UnknownKindError``.

        Args:
            value: A ``Kind`` member or a string such as ``"expense"``.

        Returns:
            The matching ``Kind`` member.

        Raises:
            UnknownKindError: When ``value`` is not a known kind.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise UnknownKindError(value) from exc


class TxType(StrEnum):
    """High-level money direction derived from ``Kind`` (never persisted)."""

    EXPENSE = "expense"
    INCOME = "income"


class Currency(StrEnum):
    """Currencies the prototype handles; ARS is the base (ADR-024)."""

    ARS = "ARS"
    USD = "USD"

    @classmethod
    def parse(cls, value: object) -> Currency:
        """Coerce a value to a ``Currency`` or raise ``UnknownCurrencyError``.

        Args:
            value: A ``Currency`` member or a string such as ``"USD"``.

        Returns:
            The matching ``Currency`` member.

        Raises:
            UnknownCurrencyError: When ``value`` is not a known currency.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise UnknownCurrencyError(value) from exc


class InstitutionType(StrEnum):
    """The kind of financial institution in the net-worth model (ADR-122, ADR-134).

    An institution is the money holder a user names once; its currency-specific
    balances live on child accounts (ADR-134). A closed enum: ``bank`` (a bank),
    ``card`` (a credit-card issuer whose balance is the outstanding charges),
    ``cash`` (physical cash) and ``wallet`` (a digital wallet / payout provider
    such as Deel, Payoneer or Mercado Pago). Investments, property and liabilities
    are deferred (ADR-122).
    """

    BANK = "bank"
    CASH = "cash"
    CARD = "card"
    WALLET = "wallet"

    @classmethod
    def parse(cls, value: object) -> InstitutionType:
        """Coerce a value to an ``InstitutionType`` or raise ``UnknownInstitutionTypeError``.

        Args:
            value: An ``InstitutionType`` member or a string such as ``"bank"``.

        Returns:
            The matching ``InstitutionType`` member.

        Raises:
            UnknownInstitutionTypeError: When ``value`` is not a known institution type.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise UnknownInstitutionTypeError(value) from exc


class FxRateType(StrEnum):
    """The source of the exchange rate used for a USD conversion (ADR-044).

    The prototype suggests the MEP (Mercado Electrónico de Pagos) rate, so ``MEP``
    stays the default for USD rows. ``MANUAL`` records a rate the user typed or
    overrode. ``OFFICIAL`` and ``CONFIGURED_DEFAULT`` are stubs for future FX work
    (#7 / #10). ``fx_rate_type`` is a plain string column, so adding members needs
    no migration.
    """

    MEP = "MEP"
    MANUAL = "manual"
    OFFICIAL = "official"
    CONFIGURED_DEFAULT = "configured_default"


# Known prototype category set (ADR-024/ADR-027). Unknown strings are tolerated.
# "Fees" backs account-to-account transfer fees, recorded as expense transactions
# (ADR-135, extends the category-addition precedent of ADR-083).
KNOWN_CATEGORIES: frozenset[str] = frozenset(
    {
        "Income",
        "Food",
        "Rent",
        "Transport",
        "Subscriptions",
        "Health",
        "Shopping",
        "Entertainment",
        "Services",
        "Taxes",
        "Fees",
        "Other",
    }
)

# Known normalized bank / channel labels (ADR-024, ADR-117). The bank is the
# filterable, normalized payment attribution; the card detail (e.g. "VISA ·5771")
# now lives on a separate ``card`` field, never folded into the bank (ADR-117).
# Unknown legacy strings are tolerated and kept as-is.
KNOWN_PAYMENT_METHODS: frozenset[str] = frozenset(
    {
        "Galicia",
        "Santander",
        "Mercado Pago",
        "Brubank",
        "Deel",
        "Transfer",
    }
)


def is_known_category(value: str) -> bool:
    """Return whether ``value`` belongs to the known prototype category set."""
    return value in KNOWN_CATEGORIES


def is_known_payment_method(value: str) -> bool:
    """Return whether ``value`` belongs to the known normalized bank set (ADR-117)."""
    return value in KNOWN_PAYMENT_METHODS
