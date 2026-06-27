---
project: margen
adr: 124
title: Accounts migration: auto-migrate bank tags to seeded accounts
category: data
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-124: Accounts migration: auto-migrate bank tags to seeded accounts

## Context

Deployed Supabase production transactions carry bank tags (Galicia, Santander, Mercado Pago, Deel) from ADR-117. The Account aggregate (ADR-122) introduces `accounts` and `transactions.account_id`. Existing rows must be migrated without data loss. Migrations auto-apply via CI before deploy (ADR-118).

## Decision

A single Alembic migration:

1. Adds the `accounts` table.
2. Adds `transactions.account_id` (nullable FK initially).
3. Deterministically seeds one account per distinct existing bank tag per user, with `opening_balance = 0` (so each account's net balance equals the sum of its existing transactions; the user sets real opening balances afterward).
4. Backfills `transactions.account_id` from the bank tag.
5. After backfill, sets `account_id` NOT NULL.

Applied to Supabase via the CI migrate job (ADR-118). The legacy bank tag column is retained for display compatibility or derived from the linked account name.

## Alternatives Considered

- **Opt-in / lazy account creation**: Users create accounts manually before transactions are linked — dual-path logic persists indefinitely, slows adoption of the new model — rejected.

## Consequences

- Rewrites all prod transaction rows in a single migration; a Supabase backup must be taken before applying (risk recorded in ADR-132).
- Seeded accounts are owned by each user per ADR-131; backfill sets `user_id` from the transaction's owner.
- `opening_balance = 0` means historical net worth is accurate from day one but the stated opening balance is 0; users must adjust if they want a true opening snapshot.
- The migration follows the one-way rewrite precedent of ADR-117.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
