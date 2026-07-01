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
    UnknownBudgetKindError,
    UnknownCurrencyError,
    UnknownInstitutionTypeError,
    UnknownKindError,
)


class Kind(StrEnum):
    """Finer-grained money direction; the persisted source of truth (ADR-027).

    ``invoice`` is income that may count toward the Monotributo annual limit;
    ``income`` is other inflow (e.g. a refund modeled as positive income).
    ``reimbursement`` is a real cash inflow that pays the owner back for a share
    of a specific past expense (ADR-158): it increases the account balance and
    net worth like any inflow, but it is NEVER ordinary income and NEVER taxable
    Monotributo turnover — instead it SUBTRACTS from the linked expense's
    category-month net spend (ADR-159/160). It is linked to its source expense
    through ``Transaction.offsets_transaction_id``.
    """

    EXPENSE = "expense"
    INCOME = "income"
    INVOICE = "invoice"
    REIMBURSEMENT = "reimbursement"

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


class BudgetKind(StrEnum):
    """Whether a budget row is a spend target or a saving allocation (ADR-138).

    A closed enum — unknown members are domain errors (like :class:`Kind` /
    :class:`Currency`). ``SPEND`` rows are per-category monthly spend targets
    compared against the category actuals (ADR-125); ``SAVING`` rows reuse the
    ``category`` column as a saving-bucket key and carry a profile-derived amount,
    so they never join the expense actuals (ADR-138). ``SPEND`` is the
    back-compatible default for existing rows and plain construction.
    """

    SPEND = "spend"
    SAVING = "saving"

    @classmethod
    def parse(cls, value: object) -> BudgetKind:
        """Coerce a value to a ``BudgetKind`` or raise ``UnknownBudgetKindError``.

        Args:
            value: A ``BudgetKind`` member or a string such as ``"spend"``.

        Returns:
            The matching ``BudgetKind`` member.

        Raises:
            UnknownBudgetKindError: When ``value`` is not a known budget kind.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise UnknownBudgetKindError(value) from exc


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
#
# MVP budgets delta (ADR-140): ``Housing`` (the INDEC-aligned superset of rent) and
# ``Education`` are added; legacy ``Rent`` is RETAINED as a tolerated alias so
# stored rows never break (no destructive rename).
#
# Phase 2 partial delta (ADR-140): ``Social`` (discretionary dining/outings, split
# from essential ``Food`` and from ``Entertainment``) is now added as a budgetable
# expense category. It is discretionary, so it is intentionally NOT in
# ``ESSENTIAL_CATEGORIES`` (``is_essential("Social")`` is False → it groups under
# "Wants"). The remaining Phase 2 categories (``Utilities`` / ``DebtService`` /
# ``FamilySupport``) are still deferred and intentionally NOT added now.
KNOWN_CATEGORIES: frozenset[str] = frozenset(
    {
        "Income",
        "Food",
        "Housing",
        "Rent",
        "Social",
        "Transport",
        "Subscriptions",
        "Health",
        "Education",
        "Shopping",
        "Entertainment",
        "Services",
        "Taxes",
        "Fees",
        "Other",
    }
)

# Saving-bucket keys (ADR-138). A ``kind='saving'`` budget row reuses the
# ``category`` column to name one of these closed buckets; its amount is a profile
# percentage of the month's net spendable income. Transcribed from the research
# saving tables (product-deliverable §2.2): the six profile buckets plus the
# spend-side ``MaintenanceReserve`` (an inflation/maintenance sinking pool also
# stored as a saving row, product-deliverable §2.2 inflation/maintenance reserve).
SAVING_BUCKETS: frozenset[str] = frozenset(
    {
        "EmergencyFund",
        "DebtAcceleration",
        "ShortTermGoals",
        "MediumTermGoals",
        "LongTermInvestment",
        "FxHedge",
        "MaintenanceReserve",
    }
)

# Essential spend categories (ADR-143, budget-design §9.1.5, LOCKED 2026-06-30).
# These define the household floor: the survival expenses a saving profile must
# never underfund. ``is_essential`` is a code constant (zero schema); a per-user
# override is deferred (Phase 2). ``Rent`` is included alongside ``Housing`` so the
# legacy alias is also treated as essential (ADR-140). ``Utilities`` and
# ``DebtService`` are Phase-2 categories but kept here so the floor is correct the
# moment they ship (tolerant strings, ADR-027).
ESSENTIAL_CATEGORIES: frozenset[str] = frozenset(
    {
        "Housing",
        "Rent",
        "Utilities",
        "Food",
        "Transport",
        "Health",
        "Education",
        "Taxes",
        "DebtService",
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


def is_essential(category: str) -> bool:
    """Return whether ``category`` is an essential spend category (ADR-143).

    Essentials define the household floor (Housing/Utilities/Food/Transport/Health/
    Education/Taxes/DebtService, plus the legacy ``Rent`` alias). Used by the pure
    ``compute_floor`` to sum essential spend targets into the floor. A code constant
    with no schema; a per-user override is deferred (Phase 2, budget-design §9.1.5).
    """
    return category in ESSENTIAL_CATEGORIES
