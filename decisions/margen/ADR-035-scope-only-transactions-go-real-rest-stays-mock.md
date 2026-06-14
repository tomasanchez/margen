---
project: margen
adr: 035
title: Scope — only transactions go real; summaries and Monotributo stay mock
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-035: Scope — only transactions go real; summaries and Monotributo stay mock

## Context

The backend currently provides only the transactions CRUD (#3, ADR-030). Summaries (#6), FX UX (#7), Monotributo calculation (#8), and settings (#10) are not built yet. Issue #14 must ship without waiting for those issues and without mixing their concerns into the transactions swap.

## Decision

In #14, ONLY the transactions CRUD switches to the real API. Home income/expenses/savings totals already derive client-side from `useTransactions()`, so they become real automatically with no additional work. The spending trend, category breakdown, insights, and ALL Monotributo data (scale/invoices/projection/snapshot, ADR-023) STAY on mock data behind their existing query-hook seam until #6/#8/#10 ship. The in-memory transactions store and transaction seed data are removed; all remaining mock data and their hook seams are kept clean and documented as explicitly pending.

## Alternatives Considered

- **Also derive trend/category/Monotributo from real transactions now**: Scope creep — those are #6/#8's jobs; doing them here mixes concerns, risks the swap, and pre-empts design decisions those issues will make — not chosen.

## Consequences

A clear, documented boundary: transactions are real; the rest is mock behind hooks that #6/#8/#10 will replace. Removing the transaction mock proves the seam design from ADR-015 works as intended. Each subsequent issue can replace its own mock slice without touching transactions.

Note (2026-06-13): the spending trend and category breakdown are no longer mock — ADR-042 (backend summaries endpoint) and ADR-043 (frontend consumer) made them real in issue #6 / PR #14/#17. Insights and Monotributo remain mock.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
