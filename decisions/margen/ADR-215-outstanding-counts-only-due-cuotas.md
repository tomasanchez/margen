---
project: margen
adr: 215
title: "Outstanding counts only due cuotas; future cuotas are upcoming (amends ADR-206)"
category: business
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-215: Outstanding counts only due cuotas; future cuotas are upcoming (amends ADR-206)

## Context

ADR-206 defines a person's outstanding balance as the sum of each item's remainder. With installment items (ADR-214), a debt may include cuotas due months from now. Counting the full item amount as owed immediately contradicts how installment debts actually accrue — a cuota isn't really "owed" until its due date arrives — and would overstate what the owner should actively be collecting today, inflate the overpayment-warning threshold (ADR-206), and misrepresent the PDF hero balance (ADR-211/212).

## Decision

For installment items, outstanding (both item-level and person-level) counts only cuotas whose `due_on <= today` and are not pardoned and not fully allocated — i.e. the same remainder logic as ADR-206/210, applied at the cuota grain instead of the item grain. Cuotas with a future `due_on` are **upcoming**: they do not count toward outstanding, do not feed the ADR-206 overpayment-warning threshold, and do not appear in the PDF hero balance (ADR-211/212) — they are shown separately as informational.

Non-installment items are unaffected — they keep ADR-206's original item-level formula (full remainder counts immediately).

## Alternatives Considered

- **Count the full item amount upfront, ignoring due dates**: simplest, but contradicts how installment debts actually accrue (a card cuota isn't billed/owed until its month) — rejected.
- **Show both outstanding-including-future and outstanding-due-only as equally weighted totals**: more UI complexity for v1 with no clear primary number — rejected in favor of outstanding = due-only, upcoming = separate informational total.

## Consequences

- The outstanding reader needs an "as of today" filter: `due_on <= :today AND pardoned_at IS NULL`, remainder = cuota amount minus its allocations.
- A separate "upcoming" aggregate (sum of future, non-pardoned cuotas) is computed and surfaced alongside outstanding, not merged into it.
- The ADR-206 overpayment-warning threshold is recomputed using due-only outstanding for installment items.
- Time-dependent behavior: tests must inject an explicit "today" rather than relying on wall-clock time (tracked as a risk in ADR-223).
- Amends ADR-206 (outstanding formula) for installment items specifically; non-installment items keep ADR-206 unchanged. Relates to ADR-210 (pardon exclusion, extended to the cuota grain), ADR-214 (schema), ADR-221 (allocation targeting that outstanding is computed against), ADR-222 (PDF rendering of due vs. upcoming).

## Status History

- 2026-11-06: accepted
