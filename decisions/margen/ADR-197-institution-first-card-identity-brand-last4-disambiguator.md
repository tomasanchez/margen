---
project: margen
adr: 197
title: Institution-first card identity; brand+last4 is only a disambiguator
category: architecture
date: 2026-07-07
status: accepted
supersedes: ADR-190
authors: [Tomas Sanchez]
---

# ADR-197: Institution-first card identity; brand+last4 is only a disambiguator

## Context

ADR-190 introduced in-flow card registration and upgraded auto-match to use `(card_brand + card_last4, currency)` as the primary key for identifying a card account from a parsed statement. It also introduced a strict rule: when the parser produces a precise brand+last4 identity, the matcher must refuse name-based fallback and return no match if no institution with that brand+last4 is found.

That strict rule caused a regression for cards created before ADR-190 (or created through the normal institution setup flow without going through the statement import wizard): those institutions have no `card_brand` / `card_last4` values stored. When a statement is imported for such a card, the matcher finds brand+last4 in the parse result, finds no institution with matching columns, and — following the ADR-190 strict rule — returns no match. The import flow then offers the "Register this card" wizard, which, if confirmed, creates a second institution for a card the user already holds. This duplicate institution:

1. Leaves the original institution's card accounts unattached to the import, so the ccBalance liability (ADR-185) is not populated from those charges.
2. Prevents the ADR-196 payment leg from being created — the payment leg requires an attached card account per currency, and the existing accounts remain unmatched.
3. Breaks the multi-card payment reservation (ADR-196 Bank-B scenario) for any card whose institution predates brand+last4 registration.
4. Violates the user's expectation: a card they already set up in Margen should be recognised automatically, not prompt a duplicate creation.

The root cause is a mis-ordering of identity signals: ADR-190 treated `(brand, last4)` as a primary key and degraded issuer name to a fallback, when in practice the institution — identified by its display name matching the statement's issuer name — is the stable, user-visible identity anchor. Brand+last4 are useful only for the narrow case of multiple cards from the same issuer.

## Decision

**Card identity is institution-first. Brand+last4 is a disambiguator only.**

**1. Issuer-name match is the primary resolution step.**

Statement-import card matching resolves the institution first, by comparing the statement's parsed `bankName` to the names of the user's CARD-type institutions. If exactly one institution matches the issuer name, that institution is selected — regardless of whether `card_brand` / `card_last4` are populated on it. No registration is required for an existing card to be recognised.

**2. Brand+last4 is used only to disambiguate same-name collisions.**

If two or more of the user's card institutions share the same issuer name (the user holds multiple cards from the same bank), the matcher applies brand+last4 as a secondary filter: among the same-name candidates, select the one whose `card_brand` and `card_last4` match the parse result. If none match or the result is still ambiguous, prompt the user to pick or register.

**3. "Register this card" is a genuine last resort.**

The RegisterCardForm (in-flow institution creation wizard) is shown only when no existing card institution matches the issuer name at all — meaning this is truly a card the user has never set up in Margen. It is never shown when an institution already matches by name, even if that institution has no brand+last4 stored.

**4. Brand+last4 columns (ADR-190) are retained for the disambiguation use case.**

The `card_brand` / `card_last4` nullable columns on `institutions` remain. Registration via the wizard still populates them. Existing institutions without these values are matched by name and are not penalised for lacking them.

**5. ADR-190's strict "refuse name-fallback" rule is superseded.**

The rule that a parse carrying a precise brand+last4 identity must refuse name-only fallback and return no match is revoked. Name matching is now the primary step, not a fallback of last resort.

## Alternatives Considered

- **Keep ADR-190's strict rule, backfill brand+last4 on all existing card institutions**: Would fix the immediate regression but requires a migration or a user-facing re-registration pass for every pre-existing card; adds friction and risks data errors; rejected — the institution-name signal is already sufficient for the common case.
- **Require brand+last4 on all CARD institutions at creation time**: Forces users who create institutions through the normal account-setup flow (not via statement import) to enter brand+last4; adds friction with no benefit for single-card-per-bank users (the majority); rejected.
- **Fall back to name-only matching only when brand+last4 columns are null**: Partially fixes the regression but still mis-routes users who have a registered card with matching columns to the exact-match path, risking the same collision if columns exist but differ from the parse; less predictable than a clean institution-first ordering; rejected.
- **Track card identity separately from the institution aggregate**: Over-engineering for a two-signal matching problem; rejected — the nullable columns on `institutions` remain the right model.

## Consequences

- Existing card institutions (created before ADR-190, or via normal account setup without brand+last4) are auto-matched by issuer name on statement import. No migration, no re-registration needed. Retrocompatibility is restored.
- The ADR-196 payment leg fires correctly for all matched institutions: once the institution is resolved, its per-currency card accounts are used as the destination for payment legs, covering both ARS and USD balances.
- The multi-card payment reservation (ADR-196 Bank-B scenario) is unblocked for existing/unregistered cards, because the institution match now succeeds and the card accounts are attached to the import.
- The RegisterCardForm is no longer a duplicate-maker. Users who have already set up a card in Margen will never see the registration wizard for that card's statements.
- Same-issuer disambiguation (the ADR-190 primary use case) is preserved: a user holding two Galicia cards will still have their statements correctly routed to the right institution via brand+last4 secondary filter.
- Trade-off accepted: this model assumes at most one card institution per issuer name for users who have not registered brand+last4. For the very uncommon case of two same-name, same-issuer cards with no brand+last4, the matcher would be ambiguous and must prompt. This is acceptable and consistent with how users think of "my Santander card."
- Relates to ADR-089 (due-date posting — unaffected, context only), ADR-133 (per-currency native units — card accounts per currency, unchanged), ADR-184 (per-(institution,currency) card-account attachment — this ADR ensures the institution step that ADR-184 depends on resolves correctly), ADR-190 (brand+last4 registration — partially superseded; columns and wizard retained, strict primary-key rule revoked), ADR-196 (card payment leg requires an attached card account per currency — institution-first resolution restores this for existing cards).

## Status History

- 2026-07-07: accepted
- 2026-07-07: supersedes ADR-190 (strict brand+last4-primary rule revoked; institution-name match promoted to primary step)
