---
project: margen
adr: 207
title: "Server-side, name-tuned fuzzy income matching for receivables (suggestion-only)"
category: architecture
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-207: Server-side, name-tuned fuzzy income matching for receivables (suggestion-only)

## Context

Manually recording every payback payment is tedious when the payment already exists as an ordinary `kind='income'` transaction (e.g., a friend's Mercado Pago transfer). The statement-import reconciliation feature already solved a structurally similar problem: `service_layer/statement_matcher.py`'s `names_similar` heuristic (accent/case-fold normalization, shared-significant-token overlap, whole-string prefix match, and a high-threshold `SequenceMatcher` typo-tolerance fallback — ADR-084/085) flags likely duplicates between statement lines and manual expenses as a PURE, fully unit-tested function with no I/O. That heuristic is tuned for merchant/label text but the same shape of problem — fuzzy string matching between two independently-entered labels — applies to matching a person's name against an income transaction's name/description.

## Decision

A PURE matcher function, reusing/extending the `statement_matcher` heuristic (accent/case-fold, shared-token overlap, prefix match, `SequenceMatcher` ratio) but tuned for human names rather than merchant labels, runs server-side. It is fed by a new owner-scoped reader that returns the user's `kind='income'` transactions whose `occurred_on` is on or after the **person's earliest `receivable_item.occurred_on`** (not `created_at` — a person may be added to the app after their earliest debt was recorded, and matching must not miss an income that predates that data-entry timestamp). The matcher returns ranked candidate incomes per person.

Matching is **SUGGESTION-ONLY**, mirroring the statement-reconcile UX (ADR-084/086): the owner reviews ranked candidates, selects the income transaction and the item(s) it should pay off, and confirms. Confirming creates a `receivable_payment` with `source='matched_income'` and `matched_income_transaction_id` set (ADR-204), then allocates it per ADR-206. Matching **never mutates** and never edits the income transaction row itself. Once an income is confirmed/linked to a receivable payment, it is considered **claimed** and is not re-suggested for any person; a suggestion the owner explicitly dismisses also persists as dismissed so it does not resurface.

## Alternatives Considered

- **Client-side matching**: would duplicate the fuzzy-matching heuristic in the frontend and require shipping the user's full income transaction history to the browser to match against — rejected on both duplication and data-exposure grounds.
- **Auto-settle on a strong match (no confirm step)**: risks auto-creating a wrong settlement from a coincidental name/amount match; the statement-reconcile precedent (ADR-084) already established review-then-confirm as the safe pattern for exactly this class of heuristic match — rejected.
- **Write a brand-new matcher from scratch instead of reusing `statement_matcher`**: `names_similar`'s heuristic is already tested and tuned for exactly this problem shape (fuzzy label matching with typo tolerance); reinventing it would duplicate logic and testing effort for no behavioral gain — rejected.

## Consequences

- Requires a new owner-scoped income reader (filtered by `user_id`, `kind='income'`, and the per-person earliest-item-date window) and a new pure matcher module, both unit-tested to 100% coverage per the project's coverage gate.
- Requires persisting claimed/dismissed state so confirmed or explicitly-rejected income suggestions do not resurface across sessions.
- The matcher is deliberately decoupled from the general merchant-matching heuristic's tuning constants (token length, similarity threshold) since human names have different characteristics than merchant labels; the two may diverge over time without conflict.
- Relates to ADR-108/130 (ownership-scoped reader), ADR-085 (the matching heuristic and resolution semantics this reuses), ADR-086 (review-then-confirm UX precedent), ADR-204 (schema this writes into), ADR-206 (allocation flow a confirmed match feeds).

## Status History

- 2026-08-28: accepted
- 2026-08-28: scope note — v1 implements the **claimed** half of the resolution semantics only (a confirmed income is linked via `matched_income_transaction_id`, enforced server-side at confirm-time as owner-scoped + `kind='income'` + not-already-claimed, and excluded from every person's suggestions). Explicit **dismissal** of a suggestion that was NOT confirmed (persisting a dismissed `(person, income)` pair so it never resurfaces) is **DEFERRED** to a follow-up — v1 has no dismiss action; unconfirmed suggestions simply remain until claimed. Recorded so the ADR and the shipped code agree.
