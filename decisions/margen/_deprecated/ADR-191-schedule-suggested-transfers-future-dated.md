---
project: margen
adr: 191
title: Schedule suggested transfers as future-dated own-account transfers
category: architecture
date: 2026-07-06
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-191: Schedule suggested transfers as future-dated own-account transfers

## Context

ADR-189 produces a greedy, ordered list of suggested transfers that would zero the per-currency shortfall detected by ADR-188. The suggestion is display-only — no transfers are created in that slice. This ADR (Slice 2 of card-payment-planning) decides how one-click execution of those suggestions is implemented.

Two key constraints drive the design:

1. **Timing:** The user reviews the import before the statement due date. Transfers created today would appear as settled movements and immediately reduce account balances — even though the actual bank payment has not yet happened. They should "activate" only on the due date.
2. **No new lifecycle field:** ADR-185 explicitly rejected a `pending → settled` status flag on transfers. Any pending state must be encoded without adding new fields.

ADR-089 already established the convention that a transaction's `occurred_on` date determines when it enters the balance. ADR-186's as-of-today balance query excludes `occurred_on > today`. These two facts together provide a built-in deferral mechanism at zero schema cost.

## Decision

**One-click scheduling:**
The import review panel (built in ADR-189's slice) gains a single **"Schedule transfers"** button. Tapping it fires one `POST /transfers` call per greedy-suggested leg, using the existing own-account transfer endpoint (ADR-135). No new endpoint, no new aggregate, no schema change.

**Dating rule:**
- If `today < statement.period_due`: set `occurred_on = statement.period_due` (the due date).
- If `today >= statement.period_due`: set `occurred_on = today` (immediate).

When `occurred_on` is in the future, the transfer is automatically excluded from the as-of-today balance (ADR-186) and "activates" — enters balances and net-worth — on that date. The date is the state. No status field.

**Pending convention reuse:**
This is the same convention used by ADR-089 for due-date charges: a future `occurred_on` means "not yet in effect." The Transfers list already returns records regardless of `occurred_on`; no backend query change is needed.

**Surfacing in the Transfers view:**
A transfer with `occurred_on > today` is labelled **"Pending"** in the Transfers list UI. This flag is derived purely on the client from the date field — no new backend field or endpoint.

**Balance / net-worth invalidation:**
After the schedule action completes, the client invalidates the balances and net-worth queries so the pending reservation is visible immediately in the UI (balance unchanged until the due date, but the pending transfers are visible in the list).

**Scope — frontend only:**
The backend already:
- Accepts any `occurred_on` on `POST /transfers` (ADR-135).
- Returns future-dated transfers in the list query.
- Excludes future `occurred_on` from as-of-today balance (ADR-186).

No migration, no new endpoint, no backend change required for this slice.

**Cancellation / editing:**
A scheduled (pending) transfer is a normal transfer record. The user cancels or edits it using the standard transfers UI (delete or edit the individual transfer).

## Alternatives Considered

- **Status field (`pending → settled`)**: Rejected by ADR-185; would require a migration, a new field, and lifecycle management. The date convention achieves the same effect with existing infrastructure.
- **New `scheduled_transfers` aggregate or table**: No new semantics are needed beyond "future-dated transfer"; a separate aggregate would add schema complexity with no benefit; rejected.
- **New scheduling endpoint**: The existing `POST /transfers` already accepts `occurred_on`; a dedicated endpoint would duplicate logic; rejected.
- **Create transfers with `occurred_on = today` and a note**: Transfers would immediately enter the balance, distorting the user's current position before the payment is actually made; rejected.
- **Do not create transfers at all; rely only on the suggestion display**: Loses the reservation signal — the user has no confirmation that funds are earmarked and the pending transfers do not appear anywhere; rejected.

## Consequences

- A scheduled transfer is a real, balance-moving record that simply has not taken effect yet. Its presence in the transfer list provides a reservation signal without distorting the as-of-today balance (ADR-186).
- Editing or cancelling a pending transfer uses the standard transfers UI — no new UI surface needed.
- The "Pending" badge in the Transfers list is a pure client-side derivation (`occurred_on > today`); zero backend cost.
- Multiple legs from the greedy suggestion become multiple independent transfer records. If the user deletes one leg, the others remain; partial cancellation is supported naturally.
- The Home "card payment due" alert (a due-today + N-day heads-up) is still deferred and will have its own ADR when that slice is built.
- Relates to ADR-089 (due-date `occurred_on` convention — the mechanism this ADR reuses), ADR-133 (per-currency native units — transfers are currency-specific), ADR-135 (own-account transfers — the endpoint called), ADR-185 (no pending-status field — rationale for date-as-state), ADR-186 (as-of-today balance excludes future dates — the enforcement mechanism), ADR-188 (per-currency sufficiency check — the shortfall input), ADR-189 (greedy suggestion — the legs that are scheduled here).

## Status History

- 2026-07-06: accepted
- 2026-07-14: superseded by ADR-198 ("Schedule transfers" action removed from the import review flow; card payment scheduling retired)
