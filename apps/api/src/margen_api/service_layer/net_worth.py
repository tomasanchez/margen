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
from margen_api.service_layer.account_read_models import (
    AccountBalance,
    CcBalanceNative,
    InstallmentsNative,
    Liabilities,
    NetWorth,
    OtherNative,
)

_ZERO = Decimal(0)
# Money is presented to 2 decimal places (ADR-025); FX multiplication / division
# widens precision, so converted figures are quantized back to cents.
_CENTS = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class InstallmentLiabilityInput:
    """One active instalment stream's full remaining tail, for the liabilities reservation (ADR-181).

    The adapter derives one of these per active instalment plan from its LATEST posted
    cuota: the native per-cuota amount, its native currency and its remaining payment
    count (``installments_total - installments_index`` measured from the latest posted
    cuota, so paid cuotas are excluded by construction — the no-double-count property,
    ADR-181/182). The pure assembly multiplies the two and converts to the display
    currency via the SAME MEP rate net worth uses (ADR-123/183).

    Attributes:
        amount: The native per-cuota amount (ARS or USD).
        currency: The cuota's native currency (ADR-123).
        remaining_count: The number of cuotas still to come after the latest posted cuota;
            ``0`` when the plan is already fully paid (contributes nothing, ADR-182).
    """

    amount: Decimal
    currency: Currency
    remaining_count: int


@dataclass(frozen=True, slots=True)
class CcBalanceInput:
    """One native-currency subtotal of the owner's unpaid credit-card balance (ADR-185).

    The adapter derives one of these per native currency (ARS, USD) by summing the
    owner's future-dated CARD-account expense charges that are NOT part of an instalment
    plan (instalments are counted only as the tail, ADR-181). "Future-dated"
    (``occurred_on > today``) means the charge is not yet due under the pay-date
    convention (ADR-089), so it is still outstanding. The pure assembly converts the
    native subtotal to the display currency via the SAME MEP rate net worth uses
    (ADR-123/183) and also keeps it unconverted in the native breakdown for live-rate
    client conversion (ADR-133).

    Attributes:
        amount: The outstanding native balance in ``currency`` — an EXPENSE-magnitude sum
            only, so it is always positive. Future-dated credits or payments (income /
            reimbursement rows) do NOT offset it in this slice; netting credits against the
            balance is deferred (ADR-185).
        currency: The subtotal's native currency (ADR-123).
    """

    amount: Decimal
    currency: Currency


@dataclass(frozen=True, slots=True)
class DebtLiabilityInput:
    """One manual debt's native balance, for the ``liabilities.other`` leg (ADR-187).

    The adapter derives one of these per :class:`~margen_api.domain.models.debt.Debt` the
    owner maintains: its native ``current_balance`` and native currency. The pure assembly
    sums them by currency (unconverted, into ``other_native``) and converts each to the
    display currency via the SAME MEP rate net worth uses (ADR-123/183). Manual debts are
    disjoint from all transaction-derived liabilities, so they never overlap the instalment
    tail (ADR-181) or the CC balance (ADR-185) — no dedupe is needed (ADR-187).

    Attributes:
        amount: The debt's native outstanding balance in ``currency`` — a non-negative
            magnitude (ADR-187).
        currency: The debt's native currency (ADR-183).
    """

    amount: Decimal
    currency: Currency


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


def build_liabilities(
    installments: Sequence[InstallmentLiabilityInput],
    *,
    display_currency: Currency,
    mep_rate: Decimal | None,
    cc_balances: Sequence[CcBalanceInput] = (),
    debts: Sequence[DebtLiabilityInput] = (),
) -> Liabilities:
    """Assemble the typed liabilities reservation from the instalment tails, CC balance and other debts (ADR-180, ADR-181, ADR-185, ADR-187).

    The instalment liability is Σ over active streams of ``remaining_count * cuota`` -
    the FULL remaining tail. The credit-card liability is Σ over the owner's outstanding
    future-dated CARD-account charges (not yet due/paid, instalments excluded — those are
    the tail, ADR-181/185). The "other" liability is Σ over the owner's manual
    :class:`~margen_api.domain.models.debt.Debt` balances (ADR-187) — disjoint from both
    transaction-derived legs, so no dedupe is needed. Each native figure is converted into
    ``display_currency`` via the SAME MEP rate net worth uses (ADR-123/183); when the rate
    is unavailable a cross-currency figure degrades to native, consistent with how net
    worth already degrades (ADR-132). The SAME native figures are ALSO summed unconverted
    per currency into ``installments_native`` / ``cc_balance_native`` / ``other_native``
    (ADR-183 amendment) so the client can convert each liability at the LIVE MEP rate it
    uses for the assets headline (ADR-133), keeping "Net of commitments" coherent. A
    fully-paid plan (``remaining_count == 0``) contributes nothing. ``total`` sums the
    instalment tail, the CC balance and the other debts.

    Args:
        installments: The active instalment streams' native tails from the adapter.
        display_currency: The user's display currency the reservation is expressed in.
        mep_rate: The ARS-per-USD MEP rate, or ``None`` when none is available.
        cc_balances: The owner's outstanding CC-balance native subtotals per currency from
            the adapter (ADR-185); empty by default (no CARD-account charges outstanding).
        debts: The owner's manual debt native balances from the adapter (ADR-187); empty by
            default (no debts recorded), which yields a computed ``0`` ``other`` leg.

    Returns:
        The assembled :class:`Liabilities` with the instalment tail, the CC balance and the
        other debts summed and converted, the native ARS/USD breakdowns for live-rate
        client conversion (ADR-183), and the total.
    """
    installments_total = _ZERO
    native_ars = _ZERO
    native_usd = _ZERO
    for stream in installments:
        if stream.remaining_count <= 0:
            continue
        native_tail = stream.amount * stream.remaining_count
        installments_total += convert(native_tail, stream.currency, display_currency, mep_rate)
        if stream.currency is Currency.USD:
            native_usd += native_tail
        else:
            native_ars += native_tail
    installments_total = _money(installments_total)

    cc_total = _ZERO
    cc_native_ars = _ZERO
    cc_native_usd = _ZERO
    for subtotal in cc_balances:
        cc_total += convert(subtotal.amount, subtotal.currency, display_currency, mep_rate)
        if subtotal.currency is Currency.USD:
            cc_native_usd += subtotal.amount
        else:
            cc_native_ars += subtotal.amount
    cc_total = _money(cc_total)

    other_total = _ZERO
    other_native_ars = _ZERO
    other_native_usd = _ZERO
    for debt in debts:
        other_total += convert(debt.amount, debt.currency, display_currency, mep_rate)
        if debt.currency is Currency.USD:
            other_native_usd += debt.amount
        else:
            other_native_ars += debt.amount
    other_total = _money(other_total)

    return Liabilities(
        installments=installments_total,
        installments_native=InstallmentsNative(ars=_money(native_ars), usd=_money(native_usd)),
        cc_balance=cc_total,
        cc_balance_native=CcBalanceNative(ars=_money(cc_native_ars), usd=_money(cc_native_usd)),
        other=other_total,
        other_native=OtherNative(ars=_money(other_native_ars), usd=_money(other_native_usd)),
        total=_money(installments_total + cc_total + other_total),
    )


def build_net_worth(
    balances: Sequence[AccountBalanceInput],
    *,
    display_currency: Currency,
    mep_rate: Decimal | None,
    installment_liabilities: Sequence[InstallmentLiabilityInput] = (),
    cc_balance_liabilities: Sequence[CcBalanceInput] = (),
    debt_liabilities: Sequence[DebtLiabilityInput] = (),
) -> NetWorth:
    """Assemble the net-worth surface from raw per-account balances (ADR-122, ADR-123, ADR-180).

    Each account's native balance is converted into ``display_currency`` via the
    MEP rate; the total is the sum of the converted balances (assets only, unchanged
    by the liabilities reservation, ADR-122/180). Accounts are kept in the order
    supplied by the adapter (newest-first by creation), so the breakdown is
    deterministic. The typed liabilities reservation (ADR-180) is assembled ALONGSIDE
    the total from the instalment tails, and ``net_after_liabilities`` is the derived
    ``total - liabilities.total`` - never a redefinition of ``total`` (ADR-180).

    Args:
        balances: The raw per-account native balances from the adapter.
        display_currency: The user's display currency the total is expressed in
            (ADR-056).
        mep_rate: The ARS-per-USD MEP rate, or ``None`` when none is available.
        installment_liabilities: The active instalment streams' native tails feeding the
            liabilities reservation (ADR-181); empty by default (an assets-only surface).
        cc_balance_liabilities: The owner's outstanding CC-balance native subtotals feeding
            the liabilities reservation (ADR-185); empty by default. These are reserved as a
            liability and are already EXCLUDED from ``balances`` (future-dated charges are
            not in the as-of-today asset total, ADR-186), so each peso counts once.
        debt_liabilities: The owner's manual debt native balances feeding the
            ``liabilities.other`` leg (ADR-187); empty by default. Debts are NOT assets —
            they never enter ``balances``/``total`` — and are disjoint from the other legs,
            so no double-count arises (ADR-186/187).

    Returns:
        The assembled :class:`NetWorth` with the total, the per-account breakdown
        (native balance + converted balance), the typed liabilities reservation and
        ``net_after_liabilities``.
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
    total = _money(total)
    liabilities = build_liabilities(
        installment_liabilities,
        display_currency=display_currency,
        mep_rate=mep_rate,
        cc_balances=cc_balance_liabilities,
        debts=debt_liabilities,
    )
    return NetWorth(
        total=total,
        currency=display_currency,
        accounts=accounts,
        liabilities=liabilities,
        net_after_liabilities=_money(total - liabilities.total),
    )
