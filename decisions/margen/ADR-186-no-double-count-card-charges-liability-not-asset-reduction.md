---
project: margen
adr: 186
title: No double-count — unpaid card charges are a liability, not an asset reduction
category: architecture
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-186: No double-count — unpaid card charges are a liability, not an asset reduction

## Context

ADR-184 attaches imported CC statement lines to a card account. A card account has a balance that contributes to the net-worth `total` (ADR-122). ADR-185 defines the unpaid CC balance as future-dated non-installment charges on that card account.

Once charges are attached to an account, future-dated charges could affect the card account's balance. If the account balance already reflects those future-dated charges as a reduction, and those same charges are also reserved as the `ccBalance` liability (ADR-185), the obligation is counted twice in `net_after_liabilities = total − liabilities.sum`:

- Once as a lower `total` (asset side reduced by the pending charge).
- Once as a higher `liabilities.sum` (liability side increased by the same charge).

This double-count would understate `net_after_liabilities` by the full unpaid balance.

## Decision

**Invariant:** A not-yet-due card charge is counted exactly once in `net_after_liabilities` — as the `ccBalance` **liability**. It must NOT also reduce the assets `total`.

Concretely:

- The net-worth `total` (ADR-122) reflects **settled / as-of positions** — it excludes future-dated card charges from the card account's balance contribution.
- The `ccBalance` liability (ADR-185) captures those same future-dated charges as an obligation.
- `net_after_liabilities = total − liabilities.sum` therefore counts each peso once.

**The specific exclusion mechanism** (e.g., filtering future-dated card charges out of the account-balance query, or equivalent guard in the assets computation) is an implementation detail to be confirmed during review. The **invariant** — one count per peso, via the liability — is the decision.

**General property:** `net_after_liabilities` counts each peso exactly once:

| Charge state | Where it appears |
|---|---|
| Settled (occurred_on ≤ today, non-installment) | In `total` (reduces asset balance) |
| Unpaid (occurred_on > today, non-installment) | In `liabilities.cc_balance` only |
| Installment tail (remaining cuotas) | In `liabilities.installments` only (ADR-181) |

No row falls into two buckets simultaneously.

**Mechanism note:** The locked-in-only rule (ADR-182) already restricts `liabilities` to fixed obligations. This ADR adds the complementary asset-side guard: the `total` must not include what `liabilities` already reserves. The two rules together enforce the single-count property end-to-end.

## Alternatives Considered

- **Let `total` naturally include future-dated charges and subtract them via liability (the naive approach)**: This is the double-count scenario described in Context; `net_after_liabilities` would understate by the full `cc_balance`; rejected.
- **Do not introduce a cc_balance liability; instead reduce `total` for future-dated charges**: Simpler to implement but hides the obligation from the user — "Net worth" would silently drop when a statement is imported, with no labelled liability to explain why; rejected because transparency was the stated goal of ADR-180.
- **Accept approximate double-count as a known limitation**: The magnitude of CC balances is material (a full monthly statement); silent misstating of net worth is unacceptable; rejected.

## Consequences

- The account-balance query (or equivalent asset aggregation) must exclude future-dated card charges from `total`; the mechanism is implementation-defined and review-verified.
- `net_after_liabilities` is coherent: `total` reflects settled positions; `liabilities` reserves locked-in obligations; subtracting them gives a meaningful "what I have minus what I owe."
- The invariant must be documented in the net-worth service and tested: a round-trip that imports a statement, reads net worth, and verifies `total + cc_balance ≈ gross_position` (before-liability view) should pass.
- Future liability types (ADR-180's `other` field) must respect the same invariant: if they are reservations of future outflows, the asset side must not already discount them.
- Relates to ADR-089 (due-date posting — defines what "future-dated" means), ADR-122 (assets total — must exclude future-dated charges per this ADR), ADR-130 (same-owner validation — context for account attachment), ADR-180 (net-worth liabilities model — cc_balance slot this ADR protects), ADR-181 (installment liability — same single-count property applied), ADR-182 (locked-in-only rule — complementary membership guard), ADR-183 (live-rate conversion — applies to both sides of net_after_liabilities), ADR-184 (account attachment — what makes future-dated charges queryable per card), ADR-185 (cc_balance derivation — the liability side of this invariant).

## Status History

- 2026-07-03: accepted
