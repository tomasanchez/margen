---
project: margen
adr: 135
title: Account-to-account Transfers (net-zero) with fees as expense transactions
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-135: Account-to-account Transfers (net-zero) with fees as expense transactions

## Context

Moving money between the user's own accounts — e.g., an invoice deposit on Deel transferred to Galicia USD — is not income or expense. Recording it as a transaction pair would inflate income/expense totals and distort the monotributo trailing-12-month calculation (ADR-046). The owner stated explicitly: "that isn't a transaction." Total net worth must be conserved across a transfer, except for fees, which are real costs (Deel charges a transfer fee; the receiving bank may charge a receipt fee). A correct net-worth figure (ADR-122/123) requires transfers to move balances between accounts without touching the income/expense readers. Fees, however, must appear in expense reports and budgets.

## Decision

Introduce a **`Transfer`** aggregate that is distinct from a transaction:

| Field | Description |
|---|---|
| `id` | UUID PK |
| `user_id` | NOT NULL FK — per ADR-130 |
| `from_account_id` | FK → accounts (source) |
| `to_account_id` | FK → accounts (destination) |
| `amount_out` | Numeric — amount debited from source in source currency |
| `amount_in` | Numeric — amount credited to destination in destination currency |
| `occurred_on` | Date |
| `note` | Optional free text |

Key rules:

- **Same-currency transfers**: `amount_out == amount_in` — truly net-zero; no FX implied.
- **Cross-currency transfers**: `amount_out` and `amount_in` differ; the user enters the actual amount received (FX rate is implied, not fetched from any feed).
- Both `from_account_id` and `to_account_id` must belong to the authenticated user (ADR-130).

**Balance and net-worth accounting**: the account balance / net-worth calculation unions transactions and transfers. A transfer subtracts `amount_out` from the source account and adds `amount_in` to the destination account. The income/expense and monotributo readers are unaffected because they read only transaction rows.

**Fees**: each fee is recorded as a separate `kind=expense` transaction in the **"Fees"** category on the relevant account. Fee transactions are created atomically with the transfer in a single unit of work. This makes fees visible in expense reports and budget tracking.

**"Fees" category**: a new category is added to the category set (extends ADR-083).

Transfers are surfaced in their own view and are excluded from income/expense totals and monotributo calculations (ADR-046 unaffected).

## Alternatives Considered

- **Paired transfer-kind transactions / two rows per transfer**: add a `transfer` kind to the transaction table and emit two mirrored rows — rejected; pollutes the transaction `kind` enum and directly contradicts the owner's statement that a transfer "isn't a transaction." Income/expense readers would need explicit exclusion logic forever.
- **Fold fees implicitly into the transfer's sent−received gap**: treat `amount_out − amount_in` as the implicit fee cost — rejected; fees would be invisible in expense reports and budget tracking. The owner wants fees surfaced as explicit line items.
- **Auto-compute cross-currency amounts via an FX feed**: fetch the MEP or official rate and derive `amount_in` automatically — deferred; the user enters the actual amount received, which is the authoritative figure for a real transfer.

## Consequences

- New `transfers` table with the fields above; per-user ownership per ADR-130.
- Account balance and net-worth calculation unions transactions + transfers (extends ADR-122/ADR-123); no change to income/expense or monotributo readers.
- A new **"Fees"** expense category is added (extends the category set established in ADR-083).
- The transfer-create endpoint also creates one or more fee expense transactions; the entire operation is a single unit of work.
- Transfers are displayed in a dedicated transfers view, excluded from income/expense totals and from the monotributo trailing-12-month calculation (ADR-046 unaffected).
- Per-user ownership: both accounts must belong to the authenticated user (ADR-130); relates to ADR-117 (account/bank/card detail split) and ADR-134 (institution hierarchy).
- Reconciling transfers against imported bank statements is deferred to future work.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
