---
project: margen
adr: 142
title: "(Phase 2 placeholder) Savings buckets become a first-class aggregate funded by real Transfers; a bucket is a view over its account"
category: architecture
date: 2026-06-30
status: proposed
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-142: (Phase 2 placeholder) Savings buckets become a first-class aggregate funded by real Transfers; a bucket is a view over its account

## Context

MVP saving allocations live as `kind='saving'` budget rows (ADR-138) — a notional percentage allocation with no linkage to real money movement. To make saving observable in net worth and to support targets, ETAs, and sinking-fund math, saving buckets must be promoted to a first-class aggregate that is funded by real money movements. Extends ADR-125 (budgets), ADR-138 (saving rows). Reuses ADR-122/134 (accounts/net worth), ADR-130 (per-user ownership), ADR-135 (Transfers). Full design requires a Phase 2 deep-plan once the MVP reprice loop proves its keep.

## Decision

Promote saving rows into a **`SavingsBucket`** aggregate with:

- Fields: `type (emergency|goal|sinking|fx)`, `target_amount?`, `target_months?` (emergency), `due_date?` (goal), `annual_cost?` (sinking), `currency (ARS|USD)`, `account_id?` (the designated savings Account), `monthly_pct`.
- **Funding a bucket = a real `Transfer`** (ADR-135) from the operating Account to a savings Account. Saving is then observable in net worth (ADR-122/134) — not a phantom line.
- **A bucket is a view over a designated savings Account** (single source of truth = account balance). Avoid a separate reconciliation engine.
- Auto-target rules: emergency = `essential spend × target_months` (4–6 standard, 6–9 irregular income); sinking = `annual_cost ÷ months_until(due)`.
- Migration: extract MVP saving rows via `WHERE kind='saving'`; map bucket key → `type`; link to a user-designated savings Account.

This design is proposed; it will be confirmed, refined, or replaced by a Phase 2 deep-plan.

## Alternatives Considered

- **Reconciling bucket balance**: maintain an independent bucket balance that reconciles against the linked account — why not chosen: two sources of truth for the same money; reconciliation engines are a maintenance burden and an eventual consistency hazard; "view over an account" is simpler and correct.

## Consequences

- Bucket funding becomes auditable via the Transfer log (ADR-135).
- Net worth (ADR-122/134) automatically reflects saving contributions without additional read logic.
- Phase 2 introduces: `savings_buckets` table (FK-less per ADR-094, ADR-130 per-user ownership); Transfer event triggers a bucket balance update via the account balance.
- Relates to ADR-125 (base budget table), ADR-135 (Transfer funding rail), ADR-138 (MVP saving rows that this supersedes in Phase 2), ADR-144 (macro rebalancing eventually targets these buckets).

## Status History

- 2026-06-30: proposed
