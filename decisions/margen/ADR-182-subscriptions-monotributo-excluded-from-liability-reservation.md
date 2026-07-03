---
project: margen
adr: 182
title: Subscriptions and monotributo excluded from liability reservation (locked-in-only rule)
category: business
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-182: Subscriptions and monotributo excluded from liability reservation (locked-in-only rule)

## Context

ADR-180 introduced a `liabilities` reservation on net worth. ADR-179 introduced a committed-spend accent on monthly Expenses. Both concepts involve "committed" or "obligated" spending, but they serve different purposes and must have different membership to be accurate.

The question is which obligation types qualify as a liability (reducing the owner's net position) versus which are merely a committed recurring flow (spending pattern context).

## Decision

The **locked-in-only rule**: only fixed, locked-in obligations reduce `net_after_liabilities`. In Slice 1, that means installment tails only (ADR-181). Future candidates that may qualify under this rule: CC unpaid balance and other debts (deferred per ADR-180).

**Explicitly excluded from `liabilities`:**

| Obligation type | Reason for exclusion |
|----------------|---------------------|
| Recurring subscriptions (`recurring_cadence IN ('monthly','quarterly','annual')`) | Can be cancelled at will; no principal balance outstanding; ongoing flow, not a debt. |
| Monotributo cuota | AFIP monthly tax flow — can be repriced with category changes; the cuota is a periodic payment, not a principal balance owed. |

These exclusions are a **business rule**, not a technical limitation.

**Deliberate membership difference with ADR-179:** Both subscriptions and the monotributo cuota DO appear in the committed-spend accent (ADR-179) because they represent committed monthly outflows worth highlighting in Expense context. They do NOT appear in `liabilities` because they are not a debt principal. The two concepts have explicitly different membership by design.

## Alternatives Considered

- **Include subscriptions in liabilities (e.g., 12 months of remaining subscription cost)**: Treating a cancellable subscription as a liability overstates obligations — the owner could cancel Netflix tomorrow; rejected.
- **Include monotributo cuota as a liability (e.g., 12 future cuotas)**: The cuota is an ongoing tax obligation whose amount changes with AFIP scale updates, not a fixed balance owed to a creditor; representing it as a liability principal would be misleading; rejected.
- **Single unified membership for both ADR-179 and ADR-182**: Would force a choice between two legitimate but distinct concepts; the distinction is valuable — a user needs to know both "what will I definitely spend this month" (ADR-179, broader) and "what do I owe that reduces my net position" (ADR-182, stricter); rejected.

## Consequences

- The `liabilities.installments` derivation (ADR-181) filters exclusively on `recurring_cadence='installment'`; subscriptions and monotributo are never included by query construction.
- The ADR-179 committed-spend accent and the ADR-180 liabilities reservation can diverge without confusion, provided the UI labels them distinctly ("Committed spend this month" vs "Net of commitments").
- Future obligation types (CC balance, personal loans) must be evaluated against the locked-in-only rule before being added to `liabilities`. If they can be cancelled or repriced freely, they belong in ADR-179-style accents only.
- Relates to ADR-053 (monotributo category config — cuota excluded here), ADR-174 (cadence fields used to enforce the filter), ADR-177 (monotributo cuota as committed outflow — ADR-179 context only), ADR-179 (committed-spend accent — different, broader membership), ADR-180 (net-worth liabilities reservation — this rule governs its membership), ADR-181 (installment derivation — only type in Slice 1).

## Status History

- 2026-07-03: accepted
