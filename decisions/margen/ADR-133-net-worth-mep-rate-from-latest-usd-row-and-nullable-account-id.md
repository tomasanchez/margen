---
project: margen
adr: 133
title: Net-worth MEP rate derived from the user's latest USD row; transactions.account_id stays nullable
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
amends: [124]
authors: [Tomas Sanchez]
---

# ADR-133: Net-worth MEP rate from the latest USD row; `transactions.account_id` stays nullable

## Context

ADR-123 requires net worth to aggregate USD and ARS account balances by converting via the MEP rate. But the backend has no server-side FX feed: the display-currency conversion is a **frontend** transform (ADR-056), and the only ARS-per-USD figures the backend holds are the per-transaction `fx_rate` values the user confirmed on their USD rows (ADR-044/045). ADR-123 explicitly says to reuse existing FX infrastructure with no new external dependency. Implementing the net-worth reader forced a concrete decision on where the server-side rate comes from.

Separately, ADR-124 step 5 directs the accounts migration to set `transactions.account_id` `NOT NULL` after the bank-tag backfill. In practice, transactions whose `payment_method` is `NULL` (manual rows with no bank, and every row created on the hermetic SQLite e2e tier) have no bank to seed an account from, so a hard `NOT NULL` would reject legitimate rows and break the offline test tier.

## Decision

> **Amendment (2026-06-28): net-worth DISPLAY now uses the live MEP rate from dolarapi — not the latest-USD-row rate.** See "Amendment (2026-06-28): frontend live MEP rate" below. Decision items 1 and 2 are superseded for the net-worth card display; item 3 (nullable `account_id`) is UNCHANGED.

1. ~~**Net-worth MEP rate = the user's most recently observed USD `fx_rate`.** The net-worth reader selects the user's latest USD transaction carrying an `fx_rate` (ordered by `fx_rate_as_of` then `occurred_on`) and uses that rate as the ARS-per-USD MEP rate for cross-currency conversion. No new external dependency is introduced (ADR-123).~~ *(superseded for net-worth display by Amendment 2026-06-28)*

2. ~~**Degrade to native when no rate exists.** When the user has never recorded a USD rate, cross-currency conversion is skipped: each balance contributes its native figure to the total and `balanceConverted` equals the native `balance`. This is an approximate fallback, consistent with the FX-drift limitation already accepted in ADR-132.~~ *(see degradation rule in Amendment 2026-06-28)*

3. **`transactions.account_id` is nullable** (amends ADR-124 step 5). The accounts migration adds the column, backfills it from bank tags, and leaves it nullable. The transaction→account link is enforced at the application layer instead (a user may only link to their own account, ADR-130); a hard `NOT NULL` is rejected because bank-less rows are legitimate.

### Amendment (2026-06-28): frontend live MEP rate replaces latest-USD-row rate for net-worth display

The net-worth card **does not** use the rate derived from the user's latest USD transaction for display. Instead, the **frontend fetches the live MEP rate from dolarapi via `fxClient.fetchSuggestedMepRate()` (ADR-044)** and performs all conversion client-side.

Specifically, the net-worth card computes entirely client-side from each account's native balance (`balance` + `currency` from `GET /accounts/net-worth`) and the live MEP rate:

- The **total** net worth in the display currency (ADR-056).
- **Per-institution subtotals** converted via the live MEP rate.
- **Per-account converted values** for each account.
- A **currency decomposition** (e.g., total ARS-native vs. USD-native holdings).

Rationale: the user explicitly wants the current MEP value at the moment they view the net-worth card. The app already integrates dolarapi (ADR-044); no new external dependency is introduced. A stale transaction-derived rate understates or overstates current holdings whenever the MEP rate has moved since the last USD entry.

**Degrade:** when `fetchSuggestedMepRate()` returns `null` (MEP fetch fails per ADR-037 calm-error policy), the net-worth card falls back to native subtotals without cross-currency conversion — each account contributes its native `balance` and no total across currencies is shown.

Backend note: `GET /accounts/net-worth` continues to return native per-account `balance` + `currency` fields, which the frontend uses. The server-computed `balanceConverted` and aggregate `total` (still derived from the latest-USD-row rate) are **no longer used** by the net-worth card display and may be simplified or removed in a future backend cleanup (deferred — no immediate action required).

## Alternatives Considered

- ~~**Add a server-side dolarapi MEP fetch for net worth**: A new external dependency and a new failure mode on a read path; rejected per ADR-123's "reuse, no new dependency" constraint.~~ *(Amendment 2026-06-28: a client-side fetch via the existing `fxClient` was chosen instead — no new server-side dependency is introduced.)*
- **Store a per-account FX rate**: Over-models the MVP; the rate is a portfolio-wide display concern, not an account attribute. Rejected.
- **Force `account_id` NOT NULL per ADR-124 step 5**: Breaks bank-less manual rows and the hermetic e2e tier. Rejected in favor of app-layer enforcement (ADR-130).
- *(Amendment 2026-06-28)* **Keep latest-USD-row rate for display**: Presents a stale rate whenever the MEP has moved since the last USD entry — rejected; the user explicitly wants the current MEP.

## Consequences

- ~~Net worth reflects the user's last confirmed MEP rate, which may be stale between USD entries — the same FX-drift class of limitation recorded in ADR-132.~~ *(superseded by Amendment 2026-06-28 — the live MEP rate from dolarapi is used instead.)*
- ~~A user with USD holdings but no USD transaction yet sees an un-converted (native-summed) total until they record one USD rate; documented as a known limitation.~~ *(superseded — the live MEP rate is always attempted first; fallback to native subtotals applies only when the MEP fetch itself fails.)*
- *(Amendment 2026-06-28)* The net-worth card conversion logic is **client-side** (live MEP from dolarapi via ADR-044); the backend `GET /accounts/net-worth` supplies native balances only. The server-computed `balanceConverted`/`total` fields are unused by the net-worth card and are flagged for deferred backend cleanup.
- *(Amendment 2026-06-28)* When the MEP fetch returns `null` (dolarapi unavailable, ADR-037), the card degrades gracefully: native subtotals are shown per currency without cross-currency conversion; no total across currencies is presented.
- The net-worth conversion math is a pure, unit-tested function; the rate lookup and balance aggregation live in the SQLAlchemy reader (server-side SQL), keeping the domain I/O-free. *(Still applies to the backend reader; the display path now runs client-side.)*
- `account_id` nullability means ownership of the transaction→account link is solely an application-layer invariant (ADR-130), consistent with the project's app-layer ownership model (ADR-108/111). *(UNCHANGED by Amendment 2026-06-28.)*
- Cross-reference: ADR-044 (dolarapi MEP fetch), ADR-056 (display currency), ADR-123 (per-account currency net worth), ADR-037 (calm-error / null-safe degradation).

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
- 2026-06-28: amended — net-worth DISPLAY rate source changed from latest-USD-row `fx_rate` (server-side) to live MEP rate fetched client-side via `fxClient.fetchSuggestedMepRate()` (ADR-044); all net-worth card conversion (total, per-institution, per-account, currency decomposition) is now fully client-side; `account_id` nullability decision is UNCHANGED
