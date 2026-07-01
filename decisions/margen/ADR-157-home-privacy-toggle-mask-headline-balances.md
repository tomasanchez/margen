---
project: margen
adr: 157
title: Home privacy toggle to mask headline balances
category: ux
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-157: Home privacy toggle to mask headline balances

## Context

Users open the Home screen in public or over-the-shoulder settings and need a quick way to hide sensitive money figures without leaving the screen or switching accounts. No mechanism existed to conceal balances on demand.

## Decision

- A per-device privacy toggle (eye / eye-off icon) is added to the Home header.
- When active, the toggle masks the HEADLINE monetary figures on Home:
  - Income, Expenses, and Savings metric-card values.
  - Net-worth card headline total and its ARS/USD currency breakdown.
- The following are NOT masked and remain visible at all times:
  - Percentages and period-over-period deltas.
  - The Monotributo card.
  - All other Home sections: recent activity, spending trend, category amounts, budgets.
- Toggle state is persisted per-device in `localStorage`; default is OFF (amounts visible).
- Masking is display-only: data is still fetched normally; only the rendered text is replaced with a neutral mask (e.g., `••••`).
- The masked element carries an accessible label (e.g., `aria-label="hidden"`) so screen readers can announce the concealed state.

## Alternatives Considered

- **App-wide privacy mode (Accounts, Transactions, etc.)**: broader than the stated need; deferred to a potential future extension rather than bundled here — rejected for now.
- **Server-persisted preference**: per-device `localStorage` is more appropriate for a privacy feature — a user may want to hide on a shared laptop but not on their phone; server sync would conflate the two contexts — rejected.
- **Hide all Home amounts including detail lists**: the owner scoped the requirement to headline figures only; masking category drill-downs or budget line amounts was explicitly out of scope — rejected.

## Consequences

- A small client-only privacy hook (`usePrivacyToggle` or equivalent) reads/writes `localStorage` and exposes a boolean + setter.
- The metric cards (Income, Expenses, Savings) and the Net-worth card conditionally render the mask in place of monetary text.
- No backend changes; no new API calls; no data model changes.
- The feature can be extended app-wide (Accounts, Transactions screens) in a future ADR without any backend work.
- Relates to ADR-056 (preferred display currency governs Home) — the toggled mask sits on top of whatever currency is displayed per ADR-056.

## Status History

- 2026-07-01: accepted
