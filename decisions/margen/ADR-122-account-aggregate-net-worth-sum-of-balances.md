---
project: margen
adr: 122
title: First-class Account aggregate; net worth equals sum of balances
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-122: First-class Account aggregate; net worth equals sum of balances

## Context

Banks are currently modeled as a tag on transactions (ADR-117). A PFM needs accounts with explicit balances, opening balances for reconciliation, and a net-worth figure. The existing `bank` tag field has no opening-balance concept and cannot represent cash accounts, investment accounts, or any account not tied to a bank card import.

## Decision

Introduce an `Account` aggregate following the cosmic-python pattern (repository + UoW):

- `accounts` table: `id` (UUID PK), `user_id` (NOT NULL FK), `name`, `type` (bank/cash/card), `currency` (ARS/USD), `opening_balance` (Numeric), `created_at`.
- `transactions` gains an `account_id` FK (nullable initially for migration, NOT NULL after backfill — see ADR-124).
- Net worth = Σ (opening_balance + transaction deltas) across all accounts, in the user's display currency.
- MVP net-worth scope: liquid accounts only (bank/cash/card), fully transaction-derivable. Investments, assets, and liabilities are deferred.

## Alternatives Considered

- **Derive net worth from bank tags only**: No opening-balance concept, no reconciliation path, no cash or non-import accounts — rejected.
- **Hybrid tag + account**: Dual-path logic for the same concept; tags and account records would diverge — rejected.

## Consequences

- New aggregate + repository + UoW + read model (account balance reader).
- FK on `transactions.account_id` (migration in ADR-124).
- Bank tag migration seeds accounts from existing tags (ADR-124).
- Reconciliation (statement vs account balance) and non-liquid net worth (investments, property, liabilities) are future work.
- Ownership must be enforced per ADR-131 (user_id on accounts).

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
