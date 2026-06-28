---
project: margen
adr: 132
title: PFM expansion: open items and accepted risks
category: risks
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-132: PFM expansion: open items and accepted risks

## Context

A broad product repositioning and the introduction of multiple new aggregates (accounts, budgets, reports, forecasting) carries modeling risks, data-safety risks, and scope risks that should be explicitly recorded rather than left implicit.

## Decision

The following risks and open items are accepted as of this repositioning:

1. **ARS-authoritative invariant broken for accounts** (ADR-123): Per-account native currency means USD account balances are USD-authoritative. Net worth carries FX drift between MEP rate updates. Accepted — the alternative (storing USD in ARS) would misstate holdings.

2. **Accounts migration rewrites prod rows one-way** (ADR-124): The Alembic migration backfills `account_id` on all existing transactions and sets it NOT NULL. This follows the ADR-117 precedent but is irreversible. Mitigation: take a full Supabase database backup before applying the migration.

3. **Scope creep vs generic-PFM competition** (ADR-119): Entering a crowded PFM space risks feature-chasing. Guarded by the explicit non-goals in ADR-120.

4. **Net worth excludes investments, assets, and liabilities in MVP** (ADR-122): Liquid accounts only. Users with investment accounts, property, or debt will see an incomplete net-worth picture. Accepted as a known MVP limitation.

5. **Budgets have no rollover** (ADR-125): Each month starts fresh. Users who expect envelope-style or rollover budgeting may find this limiting. Deferred enhancement.

6. **Chat-bot + image-recognition channel is a large separate initiative** (ADR-121): Deferred. The frictionless capture value is acknowledged but not part of the PFM MVP.

7. **Statement reconciliation against account balances is future work** (ADR-084/085): Imported statement lines are matched against existing transactions but not yet reconciled against running account balances. A balance-based reconciliation pass is a later enhancement.

## Consequences

These are the repositioning's known limitations and must be revisited when each deferred item is scheduled. No immediate code changes result from this ADR; it serves as the risk register for the expansion.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
