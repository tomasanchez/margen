---
project: margen
adr: 041
title: Bounded month navigator with Transactions redirect and a real date picker
category: ux
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-041: Bounded month navigator with Transactions redirect and a real date picker

## Context

ADR-040 made the Home month navigator functional (`‹`/`›` step real calendar
months, defaulting to the current month). It was unbounded: users could step into
the future (where no data can exist) or arbitrarily far back, and the Add/Edit
form had no real date control — `occurredOn` was reverse-derived in the API client
from the display string (`dispDate`) plus the current calendar year (ADR-033),
which is fragile and cannot express backdating or a specific year.

## Decision

Bound the Home navigator to a reachable window of the current month plus the
previous six (7 months total), anchored on the CLIENT clock (`new Date()`, no
backend call):

- `upperBound` = current month; `›` is DISABLED at it (no future months,
  consistent with the no-future-date rule on the form).
- `lowerBound` = current month minus 6 months; `‹` steps back normally above it,
  and AT the floor it does NOT step — it invokes `onNavigateOlder`, which the
  shell wires to a TanStack Router `useNavigate({ to: '/transactions' })` plus a
  brief, calm, dismissible MUI Snackbar ("Older than 6 months — search in
  Transactions"). Older transactions remain valid; they are found via the
  Transactions ledger's own filters, not the Home navigator.
- The mobile compact picker lists ONLY the bounded window (current month down to
  the floor, newest first) plus an "Older months → Transactions" affordance that
  triggers the same redirect.
- The shared viewing month is clamped into `[lowerBound, upperBound]` on every
  write (and the seed), so it can never sit out of range.

Replace the static "Today · …" control on the Add/Edit form with a native MUI
`TextField type="date"` (no `@mui/x-date-pickers`, no date adapter — deps stay
lean). `max` = today (no future-dated transactions); backdating is allowed (no
hard floor — older entries are valid, just outside Home's navigator). Default =
today for a new transaction; EDIT prefills from the row's `occurredOn`. The picked
ISO date (`YYYY-MM-DD`) becomes a real `occurredOn` on `NewTransactionInput`, sent
straight through by the transactions client (create + patch). The fragile
`dispDate`+current-year derivation (`deriveOccurredOn`) is removed; `dispDate`
becomes a display label derived from the picked date.

## Alternatives Considered

- **Leave the navigator unbounded**: lets users wander into empty future months
  and arbitrarily far back with no path to older data — not chosen.
- **Hard-stop at the floor (no redirect)**: a dead `‹` is a worse dead-end than
  routing to the ledger where older dates are searchable — not chosen.
- **Add `@mui/x-date-pickers` + a date adapter**: heavier deps for a single
  field; the native input meets the need and keeps the bundle lean — not chosen.
- **Keep deriving `occurredOn` from `dispDate`+year**: cannot express backdating
  or a specific year and is brittle to label changes — not chosen (replaced).

## Consequences

The Home navigator is a focused 7-month window; older history lives in
Transactions (the redirect lands there, and that screen keeps its own filters
unchanged). `occurredOn` is now first-class on the form input and flows verbatim
to the backend, so a created transaction reliably lands on the picked month in
Home and backdating works. The mock panels stay month-blind (ADR-035/040). No new
dependencies. Extends ADR-040 (navigator), ADR-034 (`occurredOn` carried), and
ADR-024/030 (`occurredOn` accepted on create/patch); supersedes the
`deriveOccurredOn` mapping introduced in ADR-033.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
</content>
</invoke>
