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
3. Deterministically seeds one account per distinct existing **`(user, bank, transaction currency)`** group, with `opening_balance = 0` (so each account's net balance equals the sum of its existing transactions; the user sets real opening balances afterward). The account's `currency` is set from the group's transaction currency (ARS or USD), and its `type` is `card` if any transaction in the group carries a non-null `card` detail (ADR-117), else `bank`. `cash` stays user-created only.
4. Backfills `transactions.account_id` from the matching `(user, bank, currency)` group, so each transaction lands in its same-currency account.
5. `account_id` stays **nullable** (relaxing the original step 5): bank-less rows (`payment_method IS NULL`) and the hermetic SQLite e2e tier legitimately have no account to seed, so a hard `NOT NULL` would reject them; the owner-scoped link is enforced at the application layer instead (ADR-130).

Applied to Supabase via the CI migrate job (ADR-118). The legacy bank tag column is retained for display compatibility or derived from the linked account name.

### Correction (2026-06-27): seed per `(bank, currency)`, not per bank

The first cut seeded **one account per `(user, bank)`** with `currency` hard-coded to `'ARS'`. That was wrong: a bank holds separate ARS and USD balances, and lumping USD movements into an ARS account broke net worth (USD amounts were summed as ARS rather than via their USD-native `usd_amount`, ADR-123). The rule is corrected to group by `(user, bank, currency)` and set each account's currency from its group. Consequences:

- A bank with both ARS and USD movements now seeds **two** accounts — e.g. "Galicia" ARS and "Galicia" USD. **Currency is not encoded into the name**; two accounts may share a name and the UI disambiguates them by currency (ADR-122).
- Net worth is now correct out of the box: each account aggregates its native-currency figure and the totals convert via the MEP rate (ADR-123, ADR-133).
- On the real dataset this yields ~6 accounts: Deel→1 USD; Galicia→ARS + USD; Mercado Pago→ARS + USD; Santander→ARS only (no USD transactions).

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
- 2026-06-27: amended — seed per `(user, bank, currency)` (was per `(user, bank)`, ARS-only); account currency taken from the group so USD balances stay USD-authoritative and net worth is correct (ADR-123)
