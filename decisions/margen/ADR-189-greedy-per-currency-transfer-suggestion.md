---
project: margen
adr: 189
title: Greedy per-currency transfer suggestion that zeroes the shortfall
category: architecture
date: 2026-07-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-189: Greedy per-currency transfer suggestion that zeroes the shortfall

## Context

ADR-188 surfaces a per-currency shortfall when the user's liquid (non-card) same-currency accounts cannot cover the card payment need. Once a shortfall is known, the next user question is: "Which accounts should I move money from, and how much?"

A manual answer requires the user to inspect each account balance, pick sources, and do the arithmetic themselves. The system already has all balances client-side; a deterministic greedy algorithm can produce a concrete, actionable suggestion at zero additional cost.

The suggestion is display-only in this slice — no transfers are created. Execution is deferred.

## Decision

For each currency in which a shortfall exists (ADR-188):

**Main / pay-from account:**
- Each card has a designated **main account** per currency — the account the user intends to pay from first.
- Default: the same-currency NON-card account with the **largest balance** for that card.
- User-selectable in the import review panel before confirming; they can override the default.

**Greedy top-up from other accounts:**
When the main account balance is less than the shortfall (after the main account contributes its full balance), top it up from other same-currency NON-card accounts — **largest-balance first** — computing the exact amount to pull from each:

```
remaining = shortfall
for each source in same_currency_non_card_accounts sorted by balance DESC
    (excluding main account):
    contribution = min(remaining, source.balance)
    if contribution > 0:
        suggest "Move {contribution} from {source}"
        remaining -= contribution
    if remaining == 0:
        break
```

Each source contributes `min(remaining_shortfall, source_balance)` — no source is over-drawn and the cumulative contribution reaches exactly zero shortfall if funds allow.

**Residual gap:**
If all same-currency accounts combined still total less than the shortfall, surface a **residual gap** message ("Still short by X [currency] after all available accounts"). No cross-currency conversion is suggested.

**Output:**
A concrete ordered list: "Move X from Account A, then Y from Account B." The user sees the exact sequence and amounts before deciding to act.

**Scope — suggest only:**
This slice displays the suggestion list. One-click execution (creating future-dated transfers via ADR-135) is deferred to a later slice with its own ADR.

**Implementation:** Pure/deterministic client-side function; mirrors the account-matching style of `accountMatch.ts`. No server call. No state mutation.

## Alternatives Considered

- **Pro-rata (proportional) split across all accounts**: More "fair" but produces non-round amounts from every account simultaneously; harder for users to follow; the greedy approach with named amounts is more actionable; rejected.
- **Always suggest the single largest-balance account only**: May not cover the full shortfall; forces the user to plan the remainder manually; rejected in favour of a complete zero-shortfall plan.
- **Cross-currency fallback (convert USD surplus to cover ARS shortfall)**: Requires an FX step; ADR-133 prohibits cross-currency aggregation without explicit user action; rejected — surface the residual gap instead.
- **Server-side suggestion endpoint**: All required data (balances, shortfall) is already client-side; a round-trip adds latency with no new information; rejected.
- **Include card accounts as funding sources**: Card-to-card transfers are meaningless for payment purposes; rejected.

## Consequences

- The import review panel gains a "Suggested transfers" list below the sufficiency check (ADR-188) whenever a shortfall exists.
- The algorithm is pure and deterministic: same inputs always produce the same suggestion; unit-testable without mocks.
- The main-account selector is the only stateful UX element — the user's choice persists for the duration of the import session (not saved to the backend in this slice).
- A residual gap message is shown when total same-currency funds are insufficient; no silent failure.
- Deferred: one-click execution as future-dated transfers (ADR-135, ADR-089/186), and a Home "card payment due" alert.
- Relates to ADR-089 (due-date date convention — context for deferred execution slice), ADR-133 (per-currency native units — no cross-currency collapse), ADR-135 (account-to-account transfers — the mechanism deferred execution will use), ADR-184 (account attachment — identifies card vs. non-card accounts), ADR-186 (as-of-today native balances — the balance inputs), ADR-188 (sufficiency check — this ADR is triggered when ADR-188 detects a shortfall).

## Status History

- 2026-07-06: accepted
