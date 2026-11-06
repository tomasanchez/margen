---
project: margen
adr: 220
title: "Receivable-transaction link entry points: from the Owed item form and from the transaction row"
category: ux
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-220: Receivable-transaction link entry points: from the Owed item form and from the transaction row

## Context

The link (ADR-217) is only useful if it's easy to create from wherever the owner is already working — starting either from "someone owes me" (Owed tab) or from an existing expense transaction already in the ledger.

## Decision

Two entry points:

(a) The Owed item form gains an optional "link transaction" picker that searches the owner's own expense transactions — a new owner-scoped expense reader, filtered to `kind='expense'`.

(b) A transaction's row/detail view gains a "Someone owes me this" action that opens a prefilled new receivable item form: date, amount, and detail pre-populated from the transaction; the link pre-set to that transaction; and — when the transaction carries `installments_total` (ADR-174) — the cuota count prefilled from it (feeding ADR-216's schedule creation).

No auto-suggest or auto-link from statement imports in this iteration — deferred.

## Alternatives Considered

- **Auto-suggest linking during statement import**: no demonstrated need yet, and risks false-positive links on ambiguous matches — deferred, not rejected outright.
- **Single entry point only**: the owner's workflow naturally starts from either side depending on context (recording a new debt vs. reviewing an existing expense) — rejected in favor of both.

## Consequences

- New owner-scoped expense-search reader (read-only, `kind='expense'` filter); no suppression of already-linked expenses needed since the link is many-to-many (ADR-218).
- Transaction detail UI gains a new action.
- Prefill logic reads `installments_total` off the transaction (ADR-174) to seed the new item's cuota count (ADR-216).
- Relates to ADR-217 (the link being created), ADR-218 (many-to-many cardinality assumed by both entry points), ADR-174 (installments_total source for the prefill).

## Status History

- 2026-11-06: accepted
