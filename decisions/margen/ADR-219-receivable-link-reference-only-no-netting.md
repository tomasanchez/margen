---
project: margen
adr: 219
title: "Receivable-to-transaction link is reference-only; never nets against net worth, budgets, or category spend"
category: architecture
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-219: Receivable-to-transaction link is reference-only; never nets against net worth, budgets, or category spend

## Context

ADR-205 structurally excludes receivables from net worth. The new link (ADR-217) must not become a backdoor that reintroduces a balance/budget effect, and must not duplicate the existing reimbursement-netting mechanism (`transactions.offsets_transaction_id`, ADR-158/159/160), which already solves a related but distinct problem: netting an actual repayment transaction against the original expense it repays.

## Decision

`source_transaction_id` is read-only reference metadata for display and traceability only. It never changes net worth, account balances, budgets, or category spend — the linked expense keeps being summed at its full face value in every existing aggregation, exactly as if no link existed. The link does not use or duplicate `offsets_transaction_id`: that remains the mechanism for when a friend's actual repayment transaction is recorded and nets against the original expense. The receivable-item link answers a different question — "who still owes me for this" — not "has this expense been repaid."

## Alternatives Considered

- **Net the linked item's amount out of category spend when the item is created**: would double-count or race against the already-correct `offsets_transaction_id` reimbursement flow (ADR-158/160), and would reopen the exact net-worth leak failure mode ADR-205/198 closed by construction — rejected.

## Consequences

- No changes required to any balance, net-worth, budget, or category-spend reader.
- The two linking mechanisms — `offsets_transaction_id` (reimbursement netting) and `source_transaction_id` (receivable reference link) — coexist deliberately and answer different questions; this distinction should be preserved in code comments/docs to prevent future conflation.
- Relates to ADR-158/159/160 (reimbursement offset netting, untouched by this decision), ADR-205 (net-worth isolation this preserves), ADR-217 (the link this governs).

## Status History

- 2026-11-06: accepted
