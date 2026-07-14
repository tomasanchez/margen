---
project: margen
adr: 184
title: Statement imports attach each charge to the (institution, currency) card account
category: data
date: 2026-07-03
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-184: Statement imports attach each charge to the (institution, currency) card account

## Context

Prior to this decision, imported credit-card statement lines landed with `account_id = None` — charges existed as transactions but were not associated with any account. This made it impossible to aggregate a card's outstanding balance, broke any per-account balance view for card holders, and left the `ccBalance` liability placeholder (ADR-180) unpopulatable.

Argentine credit cards carry separate peso and dólar balances — each is a distinct account (e.g., Galicia ARS, Galicia USD). The statement parse result already exposes `bankName`, `issuerCuit`, `cardLast4`, and a per-line `currency` (ARS or USD), giving enough information to deduce the target account without extra user input on the happy path.

## Decision

Each imported statement line is attached to a specific card account via **frontend deduction + user confirmation**:

1. **Deduce**: The frontend resolves `issuerCuit` / `cardLast4` → the user's CARD institution, then the line's `currency` → that institution's ARS *or* USD account. Argentine dual-balance cards map to two separate accounts; the line currency selects which one.
2. **Pre-select**: The deduced `account_id` is pre-selected in the import review table — one visible selection per currency group.
3. **Confirm or override**: The user sees the pre-selected account on the review screen and can override it before confirming the import.
4. **Contract**: `account_id` is added to the statement-line import contract (request payload sent to the backend on confirm).
5. **Validation**: The backend validates that the target account is owned by the authenticated user (same-owner rule — ADR-130). A line whose `account_id` fails validation is rejected.
6. **No match**: When the parsed card has no corresponding account in the user's account list (card not yet set up), the charge is imported unattached (`account_id = None`) rather than blocking the import.

## Alternatives Considered

- **Backend deduction (server resolves account from issuer/currency)**: Moves the matching logic server-side; requires the backend to know the user's card-account roster; adds a lookup round-trip and couples the parser to the account model; rejected — the frontend already has the account list and the deduction is pure UI logic.
- **Always require manual selection per line**: Correct but creates friction for the common case where every line on a statement belongs to one of two obvious accounts (ARS / USD of the same issuer); rejected in favour of pre-selection with override.
- **Keep `account_id = None` (status quo)**: Makes the ccBalance liability (ADR-180, ADR-185) impossible to compute; unacceptable for Slice 2a goals; rejected.

## Consequences

- Imported statement lines now carry `account_id`, enabling per-card balance queries and the ccBalance liability derivation (ADR-185).
- The import review UX gains a pre-selected account column; users retain override capability.
- The backend import endpoint gains an `account_id` field in the line payload and must enforce same-owner validation (ADR-130) before persisting.
- "No match" lines are imported unattached and silently excluded from balance aggregation; a future improvement could surface a setup prompt when unmatched cards are detected.
- Relates to ADR-075 (CC statement import foundation), ADR-078 (stateless parse → batch import contract), ADR-079 (statement-line field mapping — `account_id` added), ADR-089 (due-date posting — context for when charges are dated), ADR-130 (same-owner validation — applied to `account_id`), ADR-180 (ccBalance placeholder this decision enables to populate), ADR-185 (unpaid-balance derivation — requires `account_id` to be set).

## Status History

- 2026-07-03: accepted
- 2026-07-14: superseded by ADR-198 (charges now import as ordinary expenses on a non-card account; card-account attachment retired from the import flow)
