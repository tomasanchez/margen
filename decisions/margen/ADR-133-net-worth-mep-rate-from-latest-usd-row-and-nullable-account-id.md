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

1. **Net-worth MEP rate = the user's most recently observed USD `fx_rate`.** The net-worth reader selects the user's latest USD transaction carrying an `fx_rate` (ordered by `fx_rate_as_of` then `occurred_on`) and uses that rate as the ARS-per-USD MEP rate for cross-currency conversion. No new external dependency is introduced (ADR-123).

2. **Degrade to native when no rate exists.** When the user has never recorded a USD rate, cross-currency conversion is skipped: each balance contributes its native figure to the total and `balanceConverted` equals the native `balance`. This is an approximate fallback, consistent with the FX-drift limitation already accepted in ADR-132.

3. **`transactions.account_id` is nullable** (amends ADR-124 step 5). The accounts migration adds the column, backfills it from bank tags, and leaves it nullable. The transaction→account link is enforced at the application layer instead (a user may only link to their own account, ADR-130); a hard `NOT NULL` is rejected because bank-less rows are legitimate.

## Alternatives Considered

- **Add a server-side dolarapi MEP fetch for net worth**: A new external dependency and a new failure mode on a read path; rejected per ADR-123's "reuse, no new dependency" constraint. May be revisited if a server-side FX cache is introduced for other features.
- **Store a per-account FX rate**: Over-models the MVP; the rate is a portfolio-wide display concern, not an account attribute. Rejected.
- **Force `account_id` NOT NULL per ADR-124 step 5**: Breaks bank-less manual rows and the hermetic e2e tier. Rejected in favor of app-layer enforcement (ADR-130).

## Consequences

- Net worth reflects the user's last confirmed MEP rate, which may be stale between USD entries — the same FX-drift class of limitation recorded in ADR-132.
- A user with USD holdings but no USD transaction yet sees an un-converted (native-summed) total until they record one USD rate; documented as a known limitation.
- The net-worth conversion math is a pure, unit-tested function; the rate lookup and balance aggregation live in the SQLAlchemy reader (server-side SQL), keeping the domain I/O-free.
- `account_id` nullability means ownership of the transaction→account link is solely an application-layer invariant (ADR-130), consistent with the project's app-layer ownership model (ADR-108/111).

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
