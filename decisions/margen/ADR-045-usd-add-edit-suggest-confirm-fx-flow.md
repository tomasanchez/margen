---
project: margen
adr: 045
title: USD Add/Edit suggest-then-confirm flow and FX display
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-045: USD Add/Edit suggest-then-confirm flow and FX display

## Context

Issue #7 requires that a user never wonders "which dollar is this?". Rate details must be compact but visible; the UI must never silently guess a rate. ADR-044 establishes that the MEP rate is fetched from dolarapi.com and confirmed by the user; this ADR specifies the Add/Edit form interaction and how FX metadata is displayed on transaction rows and cards.

## Decision

**Add/Edit form — currency = USD:**

When the user selects USD, the form fetches and pre-fills the suggested MEP rate (with a small loading/refresh affordance and a "suggested MEP rate — confirm or edit" hint). The rate field is required before the form can be saved; accepting the suggestion keeps `fx_rate_type = 'MEP'` while editing it switches `fx_rate_type` to `'manual'`. The rate date (`fx_rate_as_of`) defaults to the transaction's date field. If the fetch fails, the hint changes to "couldn't fetch a rate — enter it manually" and the user must provide a value.

**Display on USD rows and cards:**

The existing FX badge is retained and extended to show the rate value plus source (`MEP` or a clear "manual" indicator) compactly alongside the converted ARS equivalent. The Monotributo invoice FX sub-line follows the same compact pattern for consistency.

## Alternatives Considered

- **Keep the hardcoded MEP default**: A silent, untrustworthy guess with no user confirmation — not chosen.
- **A separate modal or step for FX entry**: Adds navigation overhead; inline + compact is the established pattern for this form — not chosen.

## Consequences

Trustworthy, visible FX with manual override clearly surfaced; one additional frontend external call (dolarapi.com, via the adapter from ADR-044) per USD transaction entry; USD transactions require a rate before saving. Relates to ADR-044 (fetch mechanism, field mapping, enum change), ADR-033 (API client conventions), ADR-037 (calm error/unavailable UX applied to the fetch-failure case).

## Status History

- 2026-06-14: proposed
- 2026-06-14: accepted
