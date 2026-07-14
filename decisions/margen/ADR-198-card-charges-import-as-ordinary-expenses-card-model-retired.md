---
project: margen
adr: 198
title: Card charges import as ordinary expenses on a non-card account; card-account model and payment-reservation machinery retired from the import flow
category: architecture
date: 2026-07-14
status: accepted
supersedes: ADR-184, ADR-185, ADR-188, ADR-189, ADR-191, ADR-192, ADR-195, ADR-196, ADR-197
authors: [Tomas Sanchez]
---

# ADR-198: Card charges import as ordinary expenses on a non-card account; card-account model and payment-reservation machinery retired from the import flow

## Context

ADR-184 through ADR-197 built a complete credit-card statement model: charges imported onto separate CARD-type accounts, a `ccBalance` liability derived from future-dated card-account expenses (ADR-185), a per-currency sufficiency check and greedy transfer suggestion shown on the import review screen (ADR-188/189), one-click scheduling of those suggestions as future-dated transfers (ADR-191), a Home card-due alert (ADR-192), an available-balance primitive and projected-balance refinement for the payment planner (ADR-193/195), a bank→card payment-leg reservation that closed the destination-earmark gap (ADR-196), and institution-first card identity matching (ADR-197).

In production, this model produced a confusing and incorrect-looking ledger:

- Card accounts accumulated large negative balances — the user had no mental model for a "card account" distinct from a bank account.
- The import flow auto-created a "Statement payment top-up" transfer the user never made, distorting the transfer list and account balances.
- The institution-first card-matching logic (ADR-197) and in-flow card registration (ADR-190) added setup friction without a corresponding benefit the user recognized.
- The `cc_balance` liability and the payment-planner sufficiency signals were not used in practice; the user reconciles card spend manually, treating it as spend that reduces their bank account.

The root cause is a mismatch between the system's model and the user's mental model. For a single-user personal-finance tool, the user's actual flow is:

1. They receive a card statement.
2. They pay the bank by moving money out of their checking/savings account via their bank's app.
3. They import the statement into Margen so the individual charges appear as categorized expenses.

They do not need Margen to plan the bank transfer for them; they execute that transfer independently and expect to log it via the ordinary own-account transfers UI (ADR-135) if they want it tracked.

A one-time production remediation was already performed: card accounts were deleted, charges were re-pointed to the user's Santander bank account (ARS), and the bogus auto-created top-up transfer was removed.

## Decision

**Statement charges import as ordinary EXPENSE transactions on a user-chosen non-card account.**

1. **Target account is a bank/cash/wallet account, not a card account.** On the import review screen the user selects (or confirms the pre-selected) non-card account to receive all charges from the statement. The default pre-selection is the same-institution, same-currency bank account (e.g., a Santander VISA/AMEX statement defaults to the user's "Santander" ARS or USD bank account). The user may override the selection.

2. **The importer never creates card institutions or card accounts.** The in-flow "Register this card" wizard (introduced in ADR-190) is removed from the import review flow. No new CARD-type institution or account is created during import.

3. **The card identity (network + last-4) is preserved on each imported line's `card` / note field** (consistent with ADR-117), e.g., "VISA ·1041", for reference and searchability. No card account is required to store this information.

4. **The payment planner is removed from the import review.** The following are no longer present in the import flow:
   - Per-currency sufficiency check (ADR-188).
   - Greedy transfer suggestion (ADR-189).
   - "Schedule transfers" / payment-leg reservation action (ADR-191 + ADR-196).
   - Home upcoming card-due alert tied to card-account charges (ADR-192).

5. **No schema migration is required.** The institution `card` TYPE and the nullable `card_brand` / `card_last4` columns added by ADR-190 remain in the database model but are no longer populated by the import flow. Existing charges already re-pointed to bank accounts in the production remediation are correct under this model.

6. **Scope is primarily frontend.** The import review component loses the planner panels; the default-account deduction switches from CARD-type to bank/cash/wallet accounts of the matching institution. The backend statement import endpoint is unchanged in its essential contract; `account_id` continues to be submitted per line, validated by the same-owner rule (ADR-130).

## Alternatives Considered

- **Keep the card-account model, improve the UX:** The negative-balance card accounts and auto-created transfers are symptomatic of a deeper model mismatch, not a UX polish problem. Hiding the confusion behind better labels does not fix the mental-model gap; rejected.
- **Make the payment planner opt-in (hidden by default):** Reduces noise but leaves dead code and a confusing code path with no active users; deferred complexity with no upside for the current single-user scope; rejected.
- **Keep card accounts for liability tracking only (without the planner):** The `ccBalance` liability is only meaningful when card accounts carry the charges. With no card accounts produced by import, the liability is inert regardless. Preserving the accounts solely for liability computation adds complexity for a signal the user does not consult; rejected.
- **Backend-driven account deduction (server selects the non-card target from issuer name):** Moves matching logic server-side; requires the backend to know the user's account roster; adds a round-trip; the frontend already has the account list and can perform the same name-based deduction client-side; rejected.

## Consequences

- **Import result:** Card spending imports as categorized expenses that reduce the chosen bank/cash/wallet account's balance. The user funds that account via the ordinary transfers UI (ADR-135), reconciled manually — exactly their existing mental model.
- **Net worth:** Each charge amount is counted exactly once as an expense against the bank account. No parallel negative card-account balance; no auto-created transfers; no `ccBalance` liability populated from card-account charges.
- **Feature surface removed:** The payment planner (sufficiency check, greedy suggestion, schedule-transfers button, payment-leg reservation, Home card-due alert) is removed from the day-to-day import flow. The code may be cleaned up or archived.
- **ADR-193 `availableBalance` primitive is retained.** It serves the expense-input transaction selector's "spendable now" display (ADR-194) and is not coupled to the card planner. Only the card-planner consumer of ADR-193 (ADR-195) is retired.
- **ADR-194 (expense-input "spendable now" selector) is retained.** Its dependency on ADR-193 is unchanged.
- **Statement parser is unchanged.** The issuer/charge/USD/tax extraction logic (ADR-075/078/079) continues to operate as before; only the downstream import review flow changes.
- **Own-account transfers (ADR-135) are unchanged.** The user continues to log bank-to-bank movements manually.
- **One-time production data remediation already performed:** Card accounts deleted, charges re-pointed to Santander bank (ARS), bogus top-up transfer removed. No further migration is required.
- **The `card_brand` / `card_last4` columns and CARD institution TYPE remain dormant in the schema.** A future slice may reintroduce card accounts with a cleaner model; nothing in the current schema prevents that.
- Relates to ADR-075/078/079 (statement parser and import contract — unchanged), ADR-089 (due-date `occurred_on` convention — retained for any future import date logic), ADR-117 (card/note field — where the card identity string is preserved), ADR-130 (same-owner validation — still enforced on the target `account_id`), ADR-133 (per-currency native units — unchanged), ADR-135 (own-account transfers — the user's manual reconciliation mechanism), ADR-193 (available-balance primitive — retained for ADR-194; only its card-planner consumer is retired), ADR-194 (expense-input spendable-now selector — unaffected).

## Status History

- 2026-07-14: accepted
