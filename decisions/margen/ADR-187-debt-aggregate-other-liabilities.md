---
project: margen
adr: 187
title: Debt aggregate for other (non-card, non-installment) liabilities
category: architecture
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-187: Debt aggregate for other (non-card, non-installment) liabilities

## Context

ADR-180 reserved `liabilities.other` as a placeholder for manual obligations that are not derived from transactions — loans, personal debts, and similar fixed-balance liabilities. ADR-181 (installment tails) and ADR-185 (unpaid CC charges) fill the other two liability legs. `liabilities.other` remains null and needs a first-class owner.

No existing aggregate covers this class of obligation. Installments are derived from transaction cuota fields (ADR-181). CC balance is derived from future-dated card-account charges (ADR-185). Manual debts — where the user tracks a balance they owe — have no home in the current schema.

The team explicitly rejected amortization and lifecycle modeling for this slice (mirroring ADR-181's YAGNI ruling on installment plans), so the required model is lightweight: a user-maintained balance record with optional extension points.

## Decision

Introduce a first-class `Debt` aggregate (table `debts`) following the existing `Account`/`Institution` aggregate pattern (ADR-122) with a reader, repository, Unit of Work, and app-layer ownership (ADR-130/134).

**Schema — `debts` table:**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | client-generated |
| `user_id` | UUID FK | owner-scoped (ADR-130) |
| `name` | text NOT NULL | human label (e.g., "Banco Nación personal loan") |
| `currency` | enum ARS/USD NOT NULL | denomination of `current_balance` |
| `current_balance` | Decimal NOT NULL | user-maintained outstanding amount |
| `monthly_minimum` | Decimal nullable | optional minimum payment; YAGNI extension point |
| `rate` | Decimal nullable | optional interest rate; YAGNI extension point |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

A new migration creates this table. No amortization schedule, no lifecycle states — the user manually updates `current_balance` as the debt changes.

**CRUD endpoints:** list / create / update / delete, all owner-scoped. No cross-user access.

**Naming:** The aggregate is `Debt` and the table is `debts`. This name is deliberately distinct from the net-worth read-model `liabilities` breakdown; `Debt` is the domain object, `liabilities.other` is the computed view it feeds.

**Net-worth integration:** `liabilities.other` = Σ `current_balance` across all `debts` for the user, grouped by native currency, expressed as `otherNative {ars, usd}`. Conversion to the net-worth display currency follows ADR-183's live-rate pattern — the same mechanism as `installmentsNative` and `ccBalanceNative`. The result folds into `liabilities.total` and `net_after_liabilities`. `Debt` balances are excluded from the assets `total`; they are a liability, not an asset reduction (consistent with ADR-186's invariant).

**Locked-in-only rule (ADR-182):** Manual debts are real, fixed obligations — they satisfy the locked-in criterion and belong in `liabilities`.

**No double-count:** `Debt` records are disjoint from all transaction-derived liabilities. A `Debt` is a standalone manual record with no link to any transaction, installment plan, or card account. It can therefore never overlap with `liabilities.installments` (ADR-181) or `liabilities.cc_balance` (ADR-185). If a user models the same real-world obligation both as a `Debt` and as tracked installments/CC charges, the app does not auto-reconcile — that is the user's responsibility to avoid.

**UI:** A "Debts" section on the existing Accounts page (ADR-127/172 — no new top-level nav), reusing the institution/account form pattern for create/edit/delete.

## Alternatives Considered

- **Reuse `Account` with a new `kind='debt'`**: The `Account` aggregate is tied to transaction-derived balances and asset semantics (ADR-122); mixing a manual liability balance into it conflates assets and liabilities at the model level; rejected.
- **Full amortization/lifecycle entity (payment schedule, status transitions)**: Rejected by the same YAGNI reasoning ADR-181 applied to installment plans — the complexity is unwarranted for a slice where manual balance entry covers the real use case; nullable `rate` and `monthly_minimum` preserve the extension path.
- **Derive `liabilities.other` from tagged transactions instead of a dedicated aggregate**: Tagging transactions as "debt payments" does not give the current outstanding balance — it gives payment history. A balance-bearing record is the right structure; rejected.
- **No first-class aggregate; accept null `liabilities.other` indefinitely**: Leaves the ADR-180 placeholder permanently empty, giving users no way to surface loans or personal debts in net worth; rejected.

## Consequences

- `liabilities.other` (ADR-180) is now populated for users who maintain `Debt` records; the placeholder becomes a live field.
- A new migration and three backend layers (repository, UoW, app service) are required — consistent with the established aggregate pattern (ADR-122/134).
- The CRUD surface is small; the nullable `monthly_minimum` and `rate` fields allow a future slice to add minimum-payment reminders or interest projections without a schema change.
- The no-double-count invariant (ADR-186) is preserved: `Debt.current_balance` does not appear in the assets `total`, only in `liabilities.other`.
- Users must self-manage consistency if they track the same real-world debt via both a `Debt` record and installment/CC transactions; no app-level reconciliation is planned.
- Relates to ADR-122 (Account/Institution aggregate pattern — `Debt` follows this), ADR-127/172 (nav constraint — Debts UI lives on Accounts page), ADR-130 (owner-scoped access — enforced on all CRUD endpoints), ADR-134 (app-layer ownership / UoW pattern), ADR-180 (net-worth layered liabilities — `other` leg this ADR populates), ADR-181 (installment liability — disjoint leg; no overlap), ADR-182 (locked-in-only rule — manual debts qualify), ADR-183 (live-rate currency conversion — `otherNative` follows same pattern), ADR-185 (cc_balance — disjoint leg; no overlap), ADR-186 (no-double-count invariant — `Debt` balances excluded from assets `total`).

## Status History

- 2026-07-03: accepted
