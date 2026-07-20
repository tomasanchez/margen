---
project: margen
adr: 199
title: Recurrence source is recurring_cadence; committed paid matching becomes category+amount (loose)
category: architecture
date: 2026-07-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-199: Recurrence source is recurring_cadence; committed paid matching becomes category+amount (loose)

## Context

A production bug surfaced two independent defects in the committed/forecast machinery built by ADR-176 (forecast engine) and ADR-179 (committed paid/pending accent):

1. **Dead recurrence signal.** The forecast's subscription stream and the committed accent's "committed" membership test both filtered on the legacy boolean `recurring = true`. Since ADR-174, recurrence is recorded via `recurring_cadence` (e.g. `monthly`, `quarterly`, `annual`, `installment`), and the app no longer sets the `recurring` boolean. In production `recurring = true` matched **zero** rows — subscriptions (OpenAI, Metrogas, Payoneer 1%, etc.) were invisible to both the forecast projection and the committed accent. A dead code path masquerading as a working filter.

2. **Exact-match paid detection failed on renamed/untagged charges.** The committed accent's "paid this month" test (ADR-179) matched a posted transaction to a stream only by exact `(name, category)`. Statement-imported charges routinely rename the merchant, and — since ADR-198 — statement charges import as plain, untagged expense transactions with no `recurring_cadence` at all. A genuinely-paid installment cuota therefore did not match its plan, and the committed accent kept showing it as "still pending" even after the statement covering it was uploaded (observed: ~ARS 971,754 shown as still-committed despite being paid). Confusing and wrong.

Both defects share a root cause: the committed/forecast layer assumed a cleaner tagging discipline than the ledger, post-ADR-198, actually has.

## Decision

### 1. Recurrence source = `recurring_cadence`

Forecast (ADR-176) and the committed accent (ADR-179) derive their **subscription** stream membership from:

```
recurring_cadence IS NOT NULL AND recurring_cadence != 'installment'
```

i.e. any non-installment cadence value counts as a subscription/periodic stream. This replaces the `recurring = true` filter everywhere it was used as a read signal. The **installment** stream source (`recurring_cadence = 'installment'`) was already correct under ADR-174/176 and is unchanged.

The `recurring` boolean is **deprecated as a read signal** — the column may remain in the schema but nothing in forecast/committed logic branches on it going forward.

### 2. Committed "paid this month" matching becomes category + amount (loose), exact match kept as first pass

A committed stream (subscription or installment) counts as **PAID** for the target month when either:

- **(a) Exact match (kept, tried first):** a this-month transaction exists with the stream's exact `(name, category)` — the original ADR-179 rule, unchanged.
- **(b) Loose fallback:** no exact match, but a this-month **expense** exists in the **same category** as the stream, with an amount within a tolerance (≈15%) of the stream's expected amount.

Matching is **greedy and one-charge-per-stream**: a given this-month charge fulfils at most one stream. Streams are matched deterministically (e.g. largest expected amount first, or closest-amount-wins) so no charge double-fulfills two streams and no stream is double-counted.

A stream matched by either rule (a) or (b) contributes to **paid** and drops out of **pending**, preserving the ADR-179 no-double-count (offset-0) invariant — the pending figure is never re-added to the spent total.

This loose-matching change is **committed-accent-specific**. The forecast engine's forward projection (future months) only picks up change (1) — the recurrence-source fix. It does not need loose paid-matching because it does not test "has this month's instance posted yet" against a renamed charge; it projects forward from the latest actual.

### 3. The committed paid/pending accent is retained

Owner decision: fix the matching, don't remove the feature. ADR-179's accent stays as originally designed; this ADR only repairs its two underlying signals.

## Alternatives Considered

- **Tag charges on import to restore exact match**: Would fix future imports if the importer applied canonical merchant names and `recurring_cadence` at import time, but ADR-198 explicitly made the importer produce plain, untagged expenses, and does nothing for already-imported historical charges. Insufficient on its own; rejected as the sole fix.
- **Fix only the subscription recurrence-source bug, leave installment matching strict (exact-match only)**: Fixes subscriptions but leaves the originally-reported bug (a renamed/untagged installment cuota showing as false-pending) unresolved. Rejected.
- **Remove the committed paid/pending accent entirely**: Sidesteps the matching problem by deleting the feature. Owner explicitly wants the accent kept; rejected.

## Consequences

- Subscriptions are recognized again by both the forecast engine (ADR-176) and the committed accent (ADR-179) — the `recurring = true` dead filter is gone from both read paths.
- A recorded charge that plausibly fulfils a recurring/installment obligation (same category, similar amount) now counts as paid even if the merchant name was renamed by statement import or the charge is untagged (per ADR-198), so the false "still pending" case largely disappears.
- Trade-off (owner-accepted): the loose fallback can occasionally attribute an unrelated same-category, similar-amount charge to a stream it doesn't actually belong to. The exact-match-first pass limits this in the common case, and the tolerance (~15%) is a tunable constant, not a hardcoded assumption.
- This is a lasting compensating control, not a one-off patch: because ADR-198 imports charges untagged and renamed by design, loose category+amount matching is what keeps the committed accent honest going forward without requiring re-tagging or a canonical-naming project.
- No schema change. `recurring_cadence` (ADR-174) already exists; this ADR only changes how forecast/committed logic reads it and how the committed accent's paid test is evaluated.
- Refines rather than replaces ADR-176 (forecast engine — recurrence-source correction only, no change to the no-double-count or projection rules) and ADR-179 (committed accent — paid-matching correction only, no change to the paid/pending accent's existence, membership set, or offset-0 rule). Neither ADR is superseded; both remain in force with this correction layered on top.
- Relates to ADR-174 (introduces `recurring_cadence`, the corrected source of truth), ADR-176 (forecast engine subscription stream source — corrected), ADR-179 (committed accent paid/pending split and no-double-count rule — matching corrected), ADR-198 (importer producing untagged/renamed expense charges — the reason loose matching is necessary going forward).

## Status History

- 2026-07-14: accepted
