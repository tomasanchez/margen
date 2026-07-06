---
project: margen
adr: 188
title: Statement import shows a per-currency card-payment sufficiency check
category: architecture
date: 2026-07-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-188: Statement import shows a per-currency card-payment sufficiency check

## Context

When a user reviews an imported credit-card statement, they must pay the resulting balance before the due date. Whether they have enough liquid funds to cover it depends on the currency of each charge: ARS lines must be paid in pesos, USD lines in dollars. Collapsing both into a single pesos total (e.g., via the existing `total_amount` field) would mix currencies and hide a real shortfall in one denomination even when the other is amply covered.

The accounts list and net-worth balances are already fetched client-side (ADR-186). The parsed statement lines are already available on the import review screen. A per-currency sufficiency signal can therefore be computed without any new endpoint.

## Decision

On the import review screen, compute a **per-currency sufficiency check** client-side before the user confirms:

**NEED per currency:**
- ARS: Σ `amount` of all kept statement lines whose currency is ARS.
- USD: Σ `usd_amount` of all kept statement lines whose currency is USD.

This uses the native per-currency amounts — NOT the pesos-only `total_amount` field, which would conflate currencies.

**AVAILABLE per currency:**
- For each currency, Σ of the **as-of-today native balances** (ADR-186) of the user's same-currency NON-card accounts (bank, cash, wallet). Card accounts are excluded because they are the destination obligation, not a funding source.

**Display:**
- For each currency that has at least one kept line, show either "Sufficient" (AVAILABLE ≥ NEED) or "Shortfall: X [currency]" (AVAILABLE < NEED).
- Currencies with zero need are omitted from the display.

**Scope:**
- Computed client-side; no new backend endpoint.
- Uses data already in the client: the accounts/net-worth balances already fetched + the parsed lines from the current session.
- Consistent with ADR-133's client-side per-currency, no-cross-currency-sum principle.
- No cross-currency conversion is performed; each currency is evaluated independently in native units.

## Alternatives Considered

- **Server-side sufficiency endpoint**: Would add a round-trip and couple the payment check to the import flow server-side; the needed data is already client-side; rejected.
- **Single-currency total using `total_amount` (pesos-only)**: Conflates ARS and USD; masks USD shortfalls even when pesos are sufficient; rejected.
- **Cross-currency sufficiency (convert USD to ARS at live rate)**: Obscures the real situation — the user must pay each currency separately; rejected in favour of per-currency native evaluation (ADR-133).
- **No sufficiency check (user decides manually)**: Acceptable UX for v1 but misses a low-cost safety signal the system can provide with already-available data; rejected.

## Consequences

- The import review screen gains a per-currency summary row showing need vs. available in native units before the user taps Confirm.
- No new backend work: this is pure frontend logic over already-fetched data.
- When a user deselects lines (excluded from the import), the need figure recalculates live, giving immediate feedback.
- If AVAILABLE < NEED, ADR-189's greedy transfer suggestion is triggered to help close the gap.
- Deferred to later slices with their own ADRs: one-click **execution** of suggested transfers as future-dated transfers (reusing ADR-135 + the date convention, ADR-089/186), and a **Home "card payment due" alert** (due-today + N-day heads-up as a calm Insights fact).
- Relates to ADR-089 (due-date posting — defines when charges are due), ADR-133 (per-currency client-side native units — governs the computation model), ADR-135 (transfers — referenced for deferred execution slice), ADR-184 (account attachment — identifies which accounts are card accounts and which are funding sources), ADR-185 (cc-balance derivation — complementary view of the same obligation), ADR-186 (as-of-today native balances — the AVAILABLE input), ADR-189 (greedy transfer suggestion — triggered when a shortfall is detected here).

## Note (refinement by ADR-189)

The displayed "Sufficient" verdict is refined by ADR-189 to be **main-account-based** (`main balance ≥ need`), not pool-based (`AVAILABLE ≥ need`). When the main/pay-from account alone is short but the same-currency pool covers it, the panel shows a shortfall **plus** the greedy transfers that zero it (residual 0) — the intended "you have the money, just move it to the pay-from account" UX. AVAILABLE is still shown as the per-currency pool total.

## Status History

- 2026-07-06: accepted
