---
project: margen
adr: 190
title: Register a card from the parsed statement persisting brand and last-4 on the institution
category: data
date: 2026-07-06
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-190: Register a card from the parsed statement persisting brand and last-4 on the institution

## Context

ADR-184 deduces the target card account from the parsed statement's `issuerCuit` / `cardLast4` + line currency. When no matching card account exists in the user's account list, the import currently falls back to importing lines unattached (`account_id = None`).

This covers the first-time case: the user imports a statement for a card they have not yet registered in Margen. Requiring them to abandon the import, navigate to account setup, create the institution and two accounts manually, and restart the import is poor UX. The system already has the card's metadata from the parser (`bankName`, `network`, `cardLast4`, currencies present in the statement) — a prefilled "Register this card" flow is low-friction.

Beyond UX, the current name-only matching is fragile: two cards from the same issuer (e.g., two Galicia cards with different ending numbers) cannot be distinguished by institution name alone. Persisting `brand` (network) + `last4` on the institution record enables precise `(issuer / brand + last4, currency)` matching, preventing same-issuer collisions.

## Decision

**In-flow card registration wizard:**
When the import review detects no matching card institution, offer a prefilled "Register this card" wizard with:
- `name` = `bankName` (from parser)
- `type` = CARD
- `currencies` = the set of currencies present in the statement lines
- `brand` = `network` field from the parser (VISA / AMEX; free-text string so Mastercard, Cabal, etc. work without code changes)
- `cardLast4` = the four-digit suffix from the parser

The user reviews, adjusts if needed, and confirms. Posture: confirm-with-override (ADR-037 / ADR-184).

**Where identity is persisted — on the institution, not the account:**
An Argentine dual-currency card is modelled as one **institution** with two child accounts (ARS + USD). The card's identity (which physical card it is) spans both currency accounts. Therefore `brand` and `last4` are stored as **nullable columns on the `institutions` table**, not on `accounts`.

A small migration adds:
- `card_brand` — varchar nullable (e.g., "VISA", "AMEX", "Mastercard")
- `card_last4` — char(4) nullable

Nullable so non-card institutions (bank, wallet, cash) are entirely unaffected; no backfill required.

**Upgraded auto-match:**
Post-registration, the frontend account-matching logic uses `(card_brand + card_last4, currency)` as the primary key for identifying a card account from a parsed statement, superseding name-only matching. Same-issuer collisions (two Galicia cards) are prevented because the ending numbers differ.

**Rejected alternative — name-only now, defer columns:**
Persisting name-only was evaluated as a simpler first step. Rejected because: (a) same-issuer collisions are a real use case (a user can hold multiple cards from the same bank), and (b) the owner confirmed they want cards registered by brand + ending number + institution from the start.

## Alternatives Considered

- **Name-only matching, defer brand/last4 columns to a later slice**: Simpler schema change; fails for users with two cards from the same issuer; rejected — owner sign-off explicitly requires brand + last4.
- **Store brand/last4 on each `accounts` row**: Would require duplicating identity fields on both the ARS and USD accounts of the same card; the institution is the natural single owner; rejected.
- **Separate `card_identity` join table**: Overkill for two nullable columns; rejected in favour of direct nullable columns on `institutions`.
- **Require the user to register the card before importing**: Breaks the flow; the parser already has the metadata; rejected.
- **Always import unattached and prompt registration separately**: Leaves the unattached-lines problem (ADR-184) in place for first imports; rejected in favour of in-flow registration.

## Consequences

- A migration adds `card_brand` (varchar, nullable) and `card_last4` (char(4), nullable) to `institutions`. Non-card institutions are unaffected.
- The "Register this card" wizard reuses the existing institution/account creation forms with prefilled values; minimal new UI surface.
- Auto-match upgrades from name-only to `(brand + last4, currency)` — more precise, resistant to same-issuer collisions.
- Nullable columns mean the backend must handle non-card institutions gracefully; the card-specific matching path gates on `card_brand IS NOT NULL`.
- Deferred to later slices with their own ADRs: one-click **execution** of suggested transfers as future-dated transfers (ADR-135 + ADR-089/186 date convention), and a **Home "card payment due" alert** (due-today + N-day heads-up as a calm Insights fact).
- Relates to ADR-037 (calm confirm-with-override UX posture), ADR-089 (due-date posting — context for deferred execution slice), ADR-122 (Account/Institution aggregate — institution is the card identity carrier), ADR-130 (same-owner validation — applies to new institution/account CRUD), ADR-133 (per-currency native units — unchanged by this ADR), ADR-135 (transfers — deferred execution mechanism), ADR-184 (account attachment + confirm-with-override posture — this ADR extends that pattern), ADR-185 (cc-balance — requires account attachment enabled by registration), ADR-186 (as-of-today native balances — used by ADR-188/189 once the card is registered).

## Status History

- 2026-07-06: accepted
- 2026-07-07: superseded by ADR-197 (institution-name match promoted to primary resolution step; strict brand+last4-primary rule revoked)
