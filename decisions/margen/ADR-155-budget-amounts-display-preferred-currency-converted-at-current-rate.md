---
project: margen
adr: 155
title: Budget amounts display in the preferred currency, converted at the current rate; native original is authoritative
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-155: Budget amounts display in the preferred currency, converted at the current rate; native original is authoritative

## Context

Budgets store targets and income in the currency they were created in (native, ADR-152), and spend is summed per-transaction using historical `usd_amount` (ADR-148). The UI was showing a native amount under a different currency label (e.g. a USD 2,000 target displayed as "ARS 2,000"), and income was being treated as UNSET when its currency differed from the active view — that guard was introduced in ADR-154. The owner clarified the intended model: the native currency is what the owner chose at creation time and must never be silently relabelled or hidden.

## Decision

- A budget's currency is the one it was created in — that is the AUTHORITATIVE original. No migration is performed; USD targets stay USD, ARS targets stay ARS.
- The UI displays every budget amount (targets, income, savings, allocation, left-to-assign) in the user's preferred display currency (the Settings `preferredDisplayCurrency`), converting any amount whose native currency differs at the CURRENT preferred-rate-source rate fetched live from the FX API (`fxClient`; source = the `preferredRateSource` setting, default bolsa/MEP). Native equals preferred → shown as-is, no conversion applied.
- SPEND retains its per-transaction historical accuracy (Σ `usd_amount` for USD budgets / Σ `amount` for ARS budgets, per ADR-148 and ADR-152) — only the forward-looking targets and income are converted at the current rate.
- This REPLACES the ADR-154 "treat a currency-mismatched income as unset" guard with live conversion. It also amends ADR-152's display rule: native storage is retained; only the display layer converts.
- Transactions (amends ADR-149): the Add/Edit Expense/Invoice form prefills the USD value from the CURRENT preferred-rate-source rate, and the user can override the rate for any transaction that used a different one. Capture stays client-side.
- The backend exposes the per-budget-line native currency so the client can apply the correct conversion per line.

## Alternatives Considered

- **Store all targets in ARS**: would eliminate the currency mismatch at display time — rejected because it discards the native original the owner deliberately chose (e.g. a USD savings goal must remain USD).
- **Guard mismatched amounts as unset (ADR-154 behaviour)**: hides the budget entirely on currency switch instead of re-expressing the target in the preferred currency — rejected as it was the root cause of the bug this decision resolves.

## Consequences

- The frontend must have the current FX rate available in (or alongside) budget queries in order to convert per-line targets and income at render time.
- Mixed-currency months are handled per-line: each target carries its native currency tag; lines whose native currency matches the preferred display currency are passed through unchanged.
- Spend figures continue to reflect capture-time rates (stored `usd_amount`), not re-conversion at the current rate — the UI should make this distinction clear (relates to ADR-154 Risk 4).
- Amends ADR-152 (display rule) and ADR-154 (removes the currency-mismatch-as-unset guard). Relates to ADR-148 (snapshot model), ADR-149 (client-side capture), ADR-151 (preferred rate source).

## Status History

- 2026-06-30: accepted
