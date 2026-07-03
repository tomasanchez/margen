"""Read models for the account + net-worth query side (ADR-122, ADR-123, ADR-134).

Purpose-built, immutable DTOs for the accounts list and the net-worth surface —
deliberately separate from the write aggregate so the two evolve independently
(AGENTS.md reader ports + read models). Money is :class:`~decimal.Decimal`
(ADR-025); the API boundary serializes it as the same Decimal style the rest of
the app uses (ADR-030). Each account carries its owning institution's ``name`` and
``type`` denormalized for the client (ADR-134).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from margen_api.domain.models.value_objects import Currency, InstitutionType


@dataclass(frozen=True, slots=True)
class AccountReadModel:
    """Query-optimized projection of a persisted account (ADR-122, ADR-134).

    Attributes:
        id: Stable UUID identity.
        institution_id: The owning institution's UUID (ADR-134).
        institution_name: The owning institution's display label (denormalized).
        type: The owning institution's kind — bank / card / cash / wallet.
        currency: The account's native currency, ARS or USD (ADR-123).
        opening_balance: The native-currency balance before any transaction.
    """

    id: UUID
    institution_id: UUID
    institution_name: str
    type: InstitutionType
    currency: Currency
    opening_balance: Decimal


@dataclass(frozen=True, slots=True)
class AccountBalance:
    """One account's derived balance for the net-worth breakdown (ADR-122, ADR-123, ADR-134).

    Attributes:
        id: The account's stable UUID identity.
        institution_id: The owning institution's UUID (ADR-134).
        institution_name: The owning institution's display label (denormalized).
        type: The owning institution's kind — bank / card / cash / wallet.
        currency: The account's native currency (ADR-123).
        balance: The native-currency balance: ``opening_balance + Σ signed deltas``
            of the account's transactions (ADR-122).
        balance_converted: The balance converted into the user's display currency
            via the MEP rate (ADR-123). Equals ``balance`` when the account's
            currency already matches the display currency, or when no rate is
            available to convert (degrade to native rather than fail, ADR-132).
    """

    id: UUID
    institution_id: UUID
    institution_name: str
    type: InstitutionType
    currency: Currency
    balance: Decimal
    balance_converted: Decimal


@dataclass(frozen=True, slots=True)
class InstallmentsNative:
    """The instalment tail as NATIVE per-currency sums, unconverted (ADR-183 amendment).

    The full remaining instalment tail broken out by the stream's native currency, with
    NO MEP rate applied. Each figure is ``Σ remaining_count * native_cuota_amount`` over
    the active instalment streams denominated in that currency. Net-worth ASSETS are
    displayed at the LIVE MEP rate on the client (ADR-133); exposing the liability's native
    breakdown lets the client convert it at the SAME live rate, so "Net of commitments"
    stays coherent when a USD tail exists and the live rate has drifted from the backend's
    stored snapshot rate (ADR-183 amendment).

    Attributes:
        ars: Σ over ARS instalment streams of ``remaining_count * cuota``, in native ARS.
        usd: Σ over USD instalment streams of ``remaining_count * cuota``, in native USD.
    """

    ars: Decimal
    usd: Decimal


@dataclass(frozen=True, slots=True)
class CcBalanceNative:
    """The unpaid credit-card balance as NATIVE per-currency sums, unconverted (ADR-185, ADR-183).

    The owner's outstanding future-dated card charges (not yet due, so not yet paid)
    summed by native currency with NO MEP rate applied. Each figure is
    ``Σ signed native charge`` over the owner's CARD-account expense rows dated after
    today and NOT part of an instalment plan (those are the instalment tail, ADR-181).
    Mirrors :class:`InstallmentsNative`: net-worth ASSETS are displayed at the LIVE MEP
    rate on the client (ADR-133), so exposing the liability's native breakdown lets the
    client convert it at the SAME live rate, keeping "Net of commitments" coherent when a
    USD balance exists and the live rate has drifted from the backend snapshot (ADR-183).

    Attributes:
        ars: Σ over ARS card charges of the outstanding native ARS balance.
        usd: Σ over USD card charges of the outstanding native USD balance.
    """

    ars: Decimal
    usd: Decimal


@dataclass(frozen=True, slots=True)
class Liabilities:
    """A typed breakdown of locked-in obligations, in the display currency (ADR-180).

    A layered reservation added ALONGSIDE the assets-only ``total`` (ADR-122): it never
    redefines the total, so the net-worth history stays coherent (ADR-180). The breakdown
    is a typed object — not a scalar — so future obligation types are ADDITIVE: Slice 1
    populates only ``installments`` (the full remaining instalment tail, ADR-181/182);
    ``cc_balance`` and ``other`` are typed placeholders (``None`` now) that populate in a
    later slice WITHOUT reshaping the response (ADR-180). ``total`` is the sum of the
    present figures, kept explicit so ``net_after_liabilities`` is a simple subtraction.

    Attributes:
        installments: Σ over active instalment streams of ``remaining_count * cuota``
            (the full remaining tail, paid cuotas excluded by construction), converted to
            the display currency via the net-worth MEP rate (ADR-181/183). Kept for API
            completeness; the client's displayed card derives its figure from
            ``installments_native`` at the LIVE rate instead (ADR-183 amendment).
        installments_native: The same instalment tail as NATIVE ARS/USD sums, unconverted,
            so the client can convert it at the SAME live MEP rate it uses for the assets
            headline (ADR-133) — keeping "Net of commitments" coherent (ADR-183 amendment).
        cc_balance: The unpaid credit-card balance liability — the owner's outstanding
            future-dated CARD-account charges (not yet due/paid, instalments excluded),
            converted to the display currency via the net-worth MEP rate (ADR-185/183).
            Kept for API completeness; the client's displayed card derives its figure from
            ``cc_balance_native`` at the LIVE rate instead (ADR-183 amendment). ``None``
            only when the owner has no such balance is NOT the rule — it is ``0`` then;
            the ``None`` typed placeholder is reserved for a not-yet-computed slice.
        cc_balance_native: The same unpaid CC balance as NATIVE ARS/USD sums, unconverted,
            so the client can convert it at the SAME live MEP rate it uses for the assets
            headline (ADR-133) — keeping "Net of commitments" coherent (ADR-185/183).
        other: A catch-all for other debts; ``None`` in Slice 1, a typed placeholder for a
            later slice (ADR-180).
        total: The sum of the present liability figures, in the display currency.
    """

    installments: Decimal
    installments_native: InstallmentsNative
    cc_balance: Decimal | None
    cc_balance_native: CcBalanceNative
    other: Decimal | None
    total: Decimal


@dataclass(frozen=True, slots=True)
class NetWorth:
    """The net-worth surface: total, liabilities and per-account breakdown (ADR-122, ADR-180).

    Attributes:
        total: The sum of every account's converted balance (assets), in ``currency``.
            Unchanged by the liabilities reservation (ADR-122/180).
        currency: The user's display currency the total is expressed in (ADR-056).
        accounts: The per-account breakdown, each carrying its native balance and
            the converted balance.
        liabilities: The typed breakdown of locked-in obligations, in ``currency``
            (ADR-180); Slice 1 populates only the instalment tail.
        net_after_liabilities: ``total - liabilities.total``, in ``currency`` - a derived
            view, not a redefinition of ``total`` (ADR-180).
    """

    total: Decimal
    currency: Currency
    accounts: list[AccountBalance]
    liabilities: Liabilities
    net_after_liabilities: Decimal
