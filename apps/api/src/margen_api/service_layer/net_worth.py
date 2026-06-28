"""Pure assembly of net worth from raw account + balance inputs (ADR-122, ADR-123).

The SQLAlchemy adapter runs the per-account balance aggregation and resolves the
display currency and MEP rate, then hands the raw figures to these pure functions,
which apply the cross-currency conversion and sum the total. Keeping this logic
free of I/O makes it fast to unit test (ADR-131) and keeps SQLAlchemy in the
adapter (AGENTS.md).

Net worth = Σ (each account's ``opening_balance + Σ signed transaction deltas +
net transfer flow``) converted into the user's display currency via the MEP rate
(ADR-122, ADR-123, ADR-135). A transaction's signed delta is ``+amount`` for income
/ invoice and ``-amount`` for expense (the ARS-equivalent magnitude is always
positive, ADR-025); for a USD account the native USD figure is used so the balance
stays USD-authoritative (ADR-123). A transfer adds ``amount_in`` to its destination
account and subtracts ``amount_out`` from its source, in each account's native
currency, so a same-currency transfer conserves total net worth (ADR-135). The
adapter folds the transfer flow into each ``AccountBalanceInput.balance`` before
these pure functions run, so this module is unchanged by transfers. The MEP rate is
ARS-per-USD.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from margen_api.domain.models.value_objects import Currency, InstitutionType
from margen_api.service_layer.account_read_models import AccountBalance, NetWorth

_ZERO = Decimal(0)
# Money is presented to 2 decimal places (ADR-025); FX multiplication / division
# widens precision, so converted figures are quantized back to cents.
_CENTS = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class AccountBalanceInput:
    """The raw per-account balance the adapter computes before FX conversion.

    Attributes:
        id: The account's identity.
        institution_id: The owning institution's UUID (ADR-134).
        institution_name: The owning institution's display label (denormalized).
        type: The owning institution's kind — bank / card / cash / wallet.
        currency: The account's native currency (ADR-123).
        balance: The native-currency balance ``opening_balance + Σ signed deltas``.
    """

    id: UUID
    institution_id: UUID
    institution_name: str
    type: InstitutionType
    currency: Currency
    balance: Decimal


def convert(amount: Decimal, source: Currency, target: Currency, mep_rate: Decimal | None) -> Decimal:
    """Convert ``amount`` from ``source`` to ``target`` currency via the MEP rate.

    The MEP rate is ARS-per-USD (ADR-044). USD→ARS multiplies by the rate; ARS→USD
    divides. A same-currency conversion is the identity. When ``mep_rate`` is
    ``None`` (no rate observed yet) or non-positive, a cross-currency conversion
    cannot be performed, so the amount is returned unchanged — net worth degrades to
    native figures rather than failing (a known FX-drift limitation, ADR-132).

    Args:
        amount: The native-currency amount to convert.
        source: The amount's currency.
        target: The currency to convert into (the display currency).
        mep_rate: The ARS-per-USD MEP rate, or ``None`` when none is available.

    Returns:
        The converted amount, or ``amount`` unchanged when no conversion applies.
    """
    if source is target:
        return amount
    if mep_rate is None or mep_rate <= _ZERO:
        return amount
    if source is Currency.USD and target is Currency.ARS:
        return amount * mep_rate
    if source is Currency.ARS and target is Currency.USD:
        return amount / mep_rate
    return amount  # pragma: no cover - only ARS/USD exist (closed enum)


def build_net_worth(
    balances: Sequence[AccountBalanceInput],
    *,
    display_currency: Currency,
    mep_rate: Decimal | None,
) -> NetWorth:
    """Assemble the net-worth surface from raw per-account balances (ADR-122, ADR-123).

    Each account's native balance is converted into ``display_currency`` via the
    MEP rate; the total is the sum of the converted balances. Accounts are kept in
    the order supplied by the adapter (newest-first by creation), so the breakdown
    is deterministic.

    Args:
        balances: The raw per-account native balances from the adapter.
        display_currency: The user's display currency the total is expressed in
            (ADR-056).
        mep_rate: The ARS-per-USD MEP rate, or ``None`` when none is available.

    Returns:
        The assembled :class:`NetWorth` with the total and the per-account
        breakdown (native balance + converted balance).
    """
    accounts: list[AccountBalance] = []
    total = _ZERO
    for item in balances:
        converted = _money(convert(item.balance, item.currency, display_currency, mep_rate))
        total += converted
        accounts.append(
            AccountBalance(
                id=item.id,
                institution_id=item.institution_id,
                institution_name=item.institution_name,
                type=item.type,
                currency=item.currency,
                balance=_money(item.balance),
                balance_converted=converted,
            )
        )
    return NetWorth(total=_money(total), currency=display_currency, accounts=accounts)
