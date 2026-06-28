---
project: margen
adr: 134
title: Institution + Account per-currency sub-accounts and wallet type
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-134: Institution + Account per-currency sub-accounts and wallet type

## Context

ADR-122 introduced a flat `accounts` table with `name`, `type`, `currency`, and `opening_balance` on a single row. This shape has two problems:

1. An institution (e.g., Galicia) that holds both an ARS account and a USD account requires two rows that are silently related only by a shared name string — there is no explicit provider entity.
2. Payment platforms such as Deel, Payoneer, and Mercado Pago are not banks or cards; the existing type enum (`bank`, `cash`, `card`) misrepresents them.

Accounts are currently empty on both DBs — the auto-seed from ADR-124 was reverted — so the model can be restructured with no data migration cost.

## Decision

Introduce a two-level hierarchy:

**`Institution`** aggregate (`id` UUID PK, `user_id` NOT NULL FK, `name`, `type` ∈ {`bank`, `card`, `cash`, `wallet`}, `created_at`) — one row per financial provider, per user.

**`Account`** becomes a per-currency leaf (`id` UUID PK, `user_id` NOT NULL FK, `institution_id` FK → institutions, `currency` ∈ {ARS, USD}, `opening_balance` Numeric, `created_at`) — drop `name` and `type` from the account row; those fields now live on Institution.

Transaction linking: `transactions.account_id` → `accounts.id` (unchanged FK column, currency-specific account). A USD transaction attaches to the institution's USD account; an ARS transaction attaches to its ARS account.

Add the **`wallet`** type to the Institution type enum to cover Deel, Payoneer, Mercado Pago, and similar payment platforms.

Account creation remains **manual only** — no auto-seed, no bulk mapping (ADR-124 reversal stands).

Transaction-to-account mapping is performed **only via the per-transaction selector** in the UI; no bulk mapper.

On the Transactions screen, retain **both** the existing Bank-tag filter (ADR-116) **and** a new Account multi-select filter. Accounts are **clickable** to drill into their transactions via an `account=<id>` URL param (extends ADR-116).

Net worth = Σ account balances converted via MEP FX — calculation logic unchanged (ADR-123, ADR-133).

## Alternatives Considered

- **Flat accounts grouped by institution name**: Keep a single table and treat name as an implicit grouper — rejected; the owner explicitly wanted a first-class Institution entity to avoid silent coupling by string match.
- **Bulk map-by-bank+currency**: Auto-assign existing transactions to accounts based on bank tag + currency — rejected; owner chose manual-only assignment to keep the mapping intentional and auditable.
- **Replace bank filter with account-only filter**: Remove the Bank-tag filter once accounts exist — rejected; owner chose to keep both filters during the transition to avoid losing the existing filtering capability.

## Consequences

- **Amends ADR-122**: the Account aggregate is restructured into an Institution + Account two-level model. The flat-account shape defined in ADR-122 is superseded by this decision.
- New `institutions` table + CRUD endpoints; `accounts` table loses `name` and `type` columns and gains `institution_id` FK. Safe restructure — accounts table is empty.
- New Institution CRUD endpoints; per-user ownership extends to institutions per ADR-130.
- Net-worth reader and account selector surface institution name/type + account currency instead of a single account name.
- Two accounts under one institution differ only by currency; the institution row carries the human-readable label.
- Transactions filters gain an Account multi-select + account drilldown URL param alongside the Bank filter (extends ADR-116).
- The `wallet` type closes the model gap for Deel, Payoneer, and Mercado Pago without forcing them into `bank` or `card`.
- Per-user ownership of Institution rows follows ADR-130; Account rows already carry `user_id`.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
