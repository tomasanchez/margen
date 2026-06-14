"""Value objects for the transaction aggregate.

``Kind`` and ``Currency`` are closed enums — unknown members are domain errors.
``Category`` and ``PaymentMethod`` mirror the prototype's known set (ADR-027) but
stay tolerant of values outside it: #6 (categories) may rename or extend the
taxonomy without invalidating stored rows, so an unknown string is accepted as-is
rather than rejected.
"""

from __future__ import annotations

from enum import StrEnum

from margen_api.domain.models.exceptions import UnknownCurrencyError, UnknownKindError


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


class FxRateType(StrEnum):
    """The exchange-rate family used for a USD conversion.

    The prototype uses the MEP (Mercado Electrónico de Pagos) rate; ``MEP`` is the
    default for USD rows. Other members allow later FX work (#7) without a schema
    change.
    """

    MEP = "MEP"
    OFFICIAL = "official"
    BLUE = "blue"


# Known prototype category set (ADR-024/ADR-027). Unknown strings are tolerated.
KNOWN_CATEGORIES: frozenset[str] = frozenset(
    {
        "Income",
        "Food",
        "Rent",
        "Transport",
        "Subscriptions",
        "Health",
        "Shopping",
        "Services",
        "Taxes",
        "Other",
    }
)

# Known prototype bank / card / channel labels (ADR-024). Unknown strings tolerated.
KNOWN_PAYMENT_METHODS: frozenset[str] = frozenset(
    {
        "Galicia · Visa",
        "Santander · Mastercard",
        "Mercado Pago",
        "Brubank",
        "Transfer",
    }
)


def is_known_category(value: str) -> bool:
    """Return whether ``value`` belongs to the known prototype category set."""
    return value in KNOWN_CATEGORIES


def is_known_payment_method(value: str) -> bool:
    """Return whether ``value`` belongs to the known prototype payment-method set."""
    return value in KNOWN_PAYMENT_METHODS
