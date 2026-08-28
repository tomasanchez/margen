---
project: margen
adr: 205
title: Receivables excluded from net worth by construction
category: architecture
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-205: Receivables excluded from net worth by construction

## Context

ADR-203 requires that receivables (money owed to the owner) never affect account balance or net worth — the money has not actually been received. Net worth is computed by `adapters/account_queries.py` and related readers, which aggregate `accounts`/`transactions` rows. Any feature that shares those tables (or is joined into their aggregation) risks leaking into balance/net-worth sums through a missed filter — this is exactly the failure mode ADR-198 documents for the retired card-account model, and the reason ADR-203 rejected modeling receivables as a filtered transaction `kind`.

## Decision

The receivables tables (`person`, `receivable_item`, `receivable_payment`, `receivable_allocation` — ADR-204) carry **no `account_id` column** and are **never read by** `adapters/account_queries.py`, the net-worth reader, or any balance-summing query. Exclusion from net worth is therefore structural — there is no filter to write, remember, or accidentally omit, and no join path exists between receivables and balance/net-worth aggregation. A test asserts that net worth is unaffected by the presence of `receivable_item`/`receivable_payment` rows (i.e., creating, editing, or deleting receivables data produces no change in a user's computed net worth).

## Alternatives Considered

- **A runtime exclusion filter on a shared/unified transactions table**: e.g., a `kind='receivable'` value filtered out of every balance and net-worth query — rejected: a single missed filter (in a new report, an insights query, a future reader) would silently corrupt real balances, exactly the class of bug ADR-198 remediated for the card-account model. Structural isolation removes the failure mode entirely rather than relying on discipline.

## Consequences

- The two "debt" concepts in the app are now deliberately separate subsystems: `Debt` (ADR-187) is money the owner owes, a real net-worth liability; receivables (ADR-203/204) is money owed to the owner, structurally outside net worth. They must never be merged or cross-referenced in aggregation code.
- No changes are required to `adapters/account_queries.py` or any existing net-worth/balance reader — this ADR's guarantee holds because receivables code paths never touch them.
- Adds one regression test (net worth ignores receivables) as the executable proof of the invariant.
- Relates to ADR-187 (Debt aggregate — the inverse, in-net-worth concept), ADR-198 (card-account remediation — the leak failure mode this ADR avoids by construction), ADR-203 (business requirement this ADR implements), ADR-204 (schema with no `account_id`).

## Status History

- 2026-08-28: accepted
