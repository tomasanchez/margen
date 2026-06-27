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

> **Reversed (2026-06-27): no auto-seed — the `accounts` table starts empty.** The
> original auto-migrate decision below was reversed before any production apply. The
> owner prefers to create accounts manually rather than have them inferred from bank
> tags. See **"Reversal (2026-06-27): empty table, manual accounts"** at the end.

A single Alembic migration:

1. Adds the `accounts` table.
2. Adds `transactions.account_id` (nullable FK initially).
3. ~~Deterministically seeds one account per distinct existing **`(user, bank, transaction currency)`** group, with `opening_balance = 0` (so each account's net balance equals the sum of its existing transactions; the user sets real opening balances afterward). The account's `currency` is set from the group's transaction currency (ARS or USD), and its `type` is `card` if any transaction in the group carries a non-null `card` detail (ADR-117), else `bank`. `cash` stays user-created only.~~ *(reversed — no seeding)*
4. ~~Backfills `transactions.account_id` from the matching `(user, bank, currency)` group, so each transaction lands in its same-currency account.~~ *(reversed — `account_id` stays NULL)*
5. `account_id` stays **nullable** (relaxing the original step 5): bank-less rows (`payment_method IS NULL`) and the hermetic SQLite e2e tier legitimately have no account to seed, so a hard `NOT NULL` would reject them; the owner-scoped link is enforced at the application layer instead (ADR-130).

Applied to Supabase via the CI migrate job (ADR-118). The legacy bank tag column is retained for display compatibility or derived from the linked account name.

### Correction (2026-06-27): seed per `(bank, currency)`, not per bank

> Superseded by the reversal below — no accounts are seeded at all. Retained for history.

The first cut seeded **one account per `(user, bank)`** with `currency` hard-coded to `'ARS'`. That was wrong: a bank holds separate ARS and USD balances, and lumping USD movements into an ARS account broke net worth (USD amounts were summed as ARS rather than via their USD-native `usd_amount`, ADR-123). The rule was corrected to group by `(user, bank, currency)` and set each account's currency from its group.

### Reversal (2026-06-27): empty table, manual accounts

The auto-seed (steps 3–4 above, including the per-`(bank, currency)` correction) is **reversed before any production apply**. The accounts migration now creates **only the empty structures**:

- The `accounts` table is created **empty**. Accounts are **not** auto-seeded from bank tags; the owner creates each account manually (e.g. "Galicia ARS", "Galicia USD", a cash account) through the accounts CRUD (ADR-122, ADR-130).
- `transactions.account_id` is added nullable and **stays NULL** for every existing row. The owner assigns each transaction to an account over time; the link is owner-checked at the application layer (ADR-130).
- The migration performs **no data rewrite** — schema only — so the Supabase-backup risk (ADR-132) and the one-way rewrite precedent (ADR-117) **no longer apply to this migration**.

Rationale: the owner wants explicit control over the account set rather than accounts inferred from historical bank tags, and an empty start avoids materializing accounts the owner may not want. Net worth handles **zero accounts** by returning a zero total with an empty breakdown in the owner's display currency (ADR-123, ADR-133), so the UI degrades gracefully until accounts exist.

The revision id (`f7a8b9c0d1e2`) and its `down_revision` (`e5f6a7b8c9d0`) are unchanged; only the `upgrade()` body lost its seeding/backfill.

## Alternatives Considered

- **Opt-in / lazy account creation**: Users create accounts manually before transactions are linked — dual-path logic persists indefinitely, slows adoption of the new model — rejected.

## Consequences

Under the **reversal** (the active decision):

- The accounts migration is **schema-only** — no transaction rows are rewritten — so no Supabase backup is required for it (the ADR-132 backup risk no longer applies to this migration).
- The `accounts` table starts **empty**; the owner creates accounts manually (ADR-122), owned per ADR-130.
- Every existing transaction's `account_id` starts **NULL** and is set as the owner assigns transactions to accounts; the link is owner-checked at the application layer (ADR-130).
- Net worth with **zero accounts** returns a zero total and an empty breakdown in the display currency, so the read path never fails before accounts exist (ADR-123, ADR-133).

Historical (under the now-reversed auto-seed):

- ~~Rewrites all prod transaction rows in a single migration; a Supabase backup must be taken before applying (risk recorded in ADR-132).~~
- ~~Seeded accounts are owned by each user per ADR-131; backfill sets `user_id` from the transaction's owner.~~
- ~~`opening_balance = 0` means historical net worth is accurate from day one but the stated opening balance is 0; users must adjust if they want a true opening snapshot.~~
- ~~The migration follows the one-way rewrite precedent of ADR-117.~~

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
- 2026-06-27: amended — seed per `(user, bank, currency)` (was per `(user, bank)`, ARS-only); account currency taken from the group so USD balances stay USD-authoritative and net worth is correct (ADR-123)
- 2026-06-27: **reversed** — no auto-seed; the `accounts` table starts empty and the owner creates accounts manually; `account_id` starts NULL and is set as the owner assigns transactions. The migration is now schema-only (no data rewrite). Reverses the original auto-migrate decision.
