---
project: margen
adr: 040
title: Functional month navigator driving the Home dashboard
category: ux
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-040: Functional month navigator driving the Home dashboard

## Context

In the #12 prototype the top-bar month switcher was cosmetic (a fixed June/May/April list; Home hard-coded the month to June). With real data wired (#14), users expect selecting a month to actually change Home. Manual testing confirmed the calendar "does nothing". ADR-017 explicitly deferred this: "the month selection state is shared between the desktop stepper and the mobile picker (cosmetic for now)."

## Decision

Make the month switcher a real month navigator: `‹`/`›` step through actual calendar months (crossing years), defaulting to the current real month; the mobile compact picker lists a window of recent months. The selected month is a shared "viewing month" lifted to a context the shell writes and Home reads.

Home's transaction-derived parts — income/expenses/savings metrics, their month-over-month deltas, the status-hero month label, and recent activity — filter to the selected month, computed from the real transactions by matching `occurredOn`'s year+month. A clean empty state shows when the selected month has no transactions.

To support precise year+month filtering, the frontend Transaction now carries `occurredOn` (ISO date) from the API (adapter change, extending ADR-034).

TRANSACTIONS keeps its own per-screen filters (it is a browse-everything ledger) — the global switcher does not scope it. The mock panels (spending trend, category breakdown, insights, Monotributo) do NOT react to the selected month yet — they remain mock until #6 (summaries) and #8 (Monotributo); they display their fixed mock regardless of the selected month.

## Alternatives Considered

- **Keep the switcher cosmetic**: It misleads users — selecting a month must do something now that data is real — not chosen.
- **Global month also scopes Transactions**: Transactions is a browse-all ledger with its own filters; a global scope would rework that UX. Home is the monthly dashboard — not chosen.
- **Limit the navigator to months that have data**: Users can't navigate to an empty month to start it; a real prev/next navigator with empty states is better — not chosen.

## Consequences

Home becomes a true monthly dashboard. Frontend Transaction gains `occurredOn` (carried by the adapter, extending ADR-034; `occurredOn` is already in the API contract per ADR-024 and ADR-030). A temporary inconsistency: Home's metrics and recent-activity react to the selected month while the still-mock trend/category/Monotributo panels (ADR-035) do not — resolved when #6/#8 make those real. Default view is the current real month; backdated/empty months show empty states. Relates to ADR-017 (switcher was cosmetic; now functional — see ADR-017 update note).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
