---
project: margen
adr: 192
title: Home surfaces an upcoming card-payment-due alert as a Monthly Insights fact
category: ux
date: 2026-07-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-192: Home surfaces an upcoming card-payment-due alert as a Monthly Insights fact

## Context

ADR-191 (Slice 2 of card-payment-planning) lets the user schedule suggested transfers as future-dated records so funds are earmarked before the statement due date. Those transfers are a reservation; they do not remind the user that the due date is approaching. The user still needs a prompt on Home so they can verify the earmarked funds are in the right account and take action if not.

ADR-089 dates every imported CC statement line on the statement due date (`occurred_on = period_due`). This means a card's outstanding charges for a given billing cycle share a common `occurred_on` that is in the future until that date passes — the same rows that feed `liabilities.cc_balance` (ADR-185). No new persistence is needed: "what is owed and when" is already encoded in existing transaction rows.

ADR-060/061 established the `MonthlyInsights` read model and its backend GET endpoint, defining a structured-facts pattern that the frontend formats into calm prose. Extending it with a new `upcomingCardDue` fact follows the same seam.

## Decision

**Alert definition:**
Produce an `upcomingCardDue` insight fact for every distinct due date that falls within `[today, today + N]` where **N = 3** (today is emphasized; days 1–3 are a heads-up). One fact per (due date, currency) grouping that has at least one qualifying charge.

**Data source (no new persistence):**
Query the existing `transactions` table:

```
upcoming_dues =
  SELECT occurred_on AS due_date,
         currency,
         SUM(amount) AS native_total
  FROM transactions
  WHERE owner_id = <current user>           -- ADR-108/130
    AND account_id IN (<card accounts>)     -- ADR-184
    AND kind = 'expense'
    AND occurred_on BETWEEN today AND today + N
  GROUP BY occurred_on, currency
```

Currency is kept native (ARS or USD) — no cross-currency sum on the server (ADR-133/186). Each (due_date, currency) pair becomes one fact entry.

**Installments ARE included** (unlike `cc_balance`, ADR-185). This is a *cash-due* alert: on the statement due date you pay the **full** amount posting that day — one-off charges **plus that period's installment cuota** — so the alert must include the cuota billed this cycle, or it understates the cash you need. This does NOT double-count the ADR-181 installment *liability tail*: that tail is every FUTURE cuota (a net-worth debt figure), whereas this alert sums only the charges dated on the near-term due date (this cycle's single cuota among them). It also keeps the alert consistent with the Slice-1 payment Need (ADR-188), which sums all kept statement lines including cuota lines.

**Read model extension:**
The `InsightsFacts` read model gains an `upcomingCardDue` field (nullable list, null when no dues fall in the window):

```
upcomingCardDue: [
  { dueDate: "YYYY-MM-DD", currency: "ARS" | "USD", amount: "<decimal-string>" }
] | null
```

The existing `AbstractInsightsReader`, `SqlAlchemyInsightsReader`, and insights service (ADR-061) are extended. No new endpoint, no migration.

**Backend assembly:**
The insights service runs the query alongside existing insight derivations. It is owner-scoped (ADR-108/130) and uses the same reader pattern as the rest of the insights layer.

**Frontend rendering:**
The `upcomingCardDue` list is rendered as one calm row per entry in the Home `Insights` surface (ADR-062), reusing the established non-color-cue + text pattern (ADR-019/037). Example prose:

- Due today (today's date): **"Card payment of ARS 12,450 due today — check your balance."**
- Future entry (within N days): **"Card payment of USD 230 due on 9 Jul."**

The `dueDate` is compared against today on the client to determine emphasis (today vs. upcoming). Formatting uses the existing es-AR locale formatters (ADR-102). No separate alerting surface, no banner, no modal.

**Interaction with ADR-191 scheduled transfers:**
The alert is informational only. Whether the user has already scheduled transfers (ADR-191) or not, the alert still fires when a due date is in `[today, today+N]`. It reminds the user to confirm the earmarked funds are in the right account. The alert does not move money or cancel scheduled transfers.

**Scope:**
- Backend: extend `InsightsFacts` read model, `AbstractInsightsReader` port, `SqlAlchemyInsightsReader`, and the insights service. No new endpoint, no schema migration.
- Frontend: render the new fact kind in the existing Insights surface. No new route or surface.

## Alternatives Considered

- **Separate alert surface (banner, badge, notification)**: Would require a new surface, new client fetch, and new UX conventions; the existing Insights panel already handles calm derived observations (ADR-060); rejected.
- **Exclude installment cuotas (mirror `cc_balance`/ADR-185)**: Rejected — this is a cash-due reminder, not a net-worth liability. Excluding the cuota billed this cycle would understate the cash actually due on the date and diverge from the Slice-1 payment Need (ADR-188), which includes cuota lines. Including this cycle's single cuota does not double-count the ADR-181 *remaining-tail* liability.
- **Single ARS-equivalent total (cross-currency sum)**: Hides per-currency obligation; ADR-133 prohibits server-side cross-currency sums; rejected.
- **Client-side derivation without backend change**: The future-dated charges require a query the client does not already hold; the backend reader pattern (ADR-061) is the correct home for this aggregation; rejected.
- **Alert only on today (no heads-up window)**: Provides no lead time for the user to act; a 3-day window gives actionable notice without noise; rejected.
- **Configurable N**: Adds a settings knob of marginal value; N=3 is a sensible default that matches typical review-and-transfer cycles; deferred.

## Consequences

- Home gains a time-sensitive derived observation for upcoming card payments with no new schema, no migration, and no new endpoint.
- The `InsightsFacts` read model gains a new nullable field; the existing backend reader layer is extended following the same pattern as ADR-061 — fully unit-testable without a database.
- The alert sums the actual card charges posting in the near-term window — one-offs PLUS that period's installment cuota — i.e. the real cash due on the date. This is broader than `cc_balance` (ADR-185), which excludes installments to avoid double-counting the net-worth tail; the two answer different questions (cash-due-now vs. outstanding-debt).
- The alert is additive to the insights panel. If no dues fall in `[today, today+N]`, the field is null and no row renders, consistent with ADR-060's graceful degradation.
- After the due date passes, `occurred_on <= today` and the charge falls out of the window naturally; the alert disappears without any manual dismissal.
- Relates to ADR-019/037 (non-color calm UX pattern — rendering convention), ADR-060/061 (insights design and backend endpoint — extended here), ADR-062 (insights frontend consumption — where the new row is rendered), ADR-089 (due-date `occurred_on` convention — the data foundation), ADR-108/130 (owner-scoping — applied in the query), ADR-133 (per-currency native amounts — governs the grouping), ADR-184 (card-account attachment — filters to card account charges), ADR-185 (cc unpaid-balance derivation — related source rows but this alert INCLUDES installments; different question), ADR-188 (Slice-1 payment Need — the alert stays consistent with it, cuotas included), ADR-191 (scheduled transfers — the execution mechanism this alert prompts the user to verify).

## Status History

- 2026-07-06: accepted
- 2026-07-06: corrected before implementation — the alert INCLUDES installment cuotas (cash-due-on-date = full statement payment, consistent with the Slice-1 Need, ADR-188), rather than mirroring `cc_balance`'s installment exclusion. The exclusion was a misapplication (that avoids a net-worth *tail* double-count, which doesn't apply to a per-date cash reminder).
