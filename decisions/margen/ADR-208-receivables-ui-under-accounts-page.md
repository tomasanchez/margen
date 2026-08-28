---
project: margen
adr: 208
title: Receivables UI under Accounts, near the existing Debts section; full CRUD
category: ux
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-208: Receivables UI under Accounts, near the existing Debts section; full CRUD

## Context

The app already has a nav-minimization pattern (ADR-127/172): new manual-record features are added as collapsible sections on the existing Accounts page rather than new top-level nav items. ADR-187's "Debts" section (money the owner owes) already lives there. Receivables (money owed to the owner — the conceptual inverse) needs its own CRUD surface: manage people, manage their itemized debts, review/confirm fuzzy income-match suggestions (ADR-207), record manual payments, and see per-person outstanding.

## Decision

Add a new collapsible "Receivables" (money owed to me) section on the Accounts page, positioned beside the existing "Debts I owe" section, following the same pattern (no new nav item). It supports full CRUD:

- Create/rename/delete a person.
- Add/edit/delete a person's itemized debts (date, amount, optional detail).
- View each person's current outstanding total.
- Review ranked income-match suggestions (ADR-207) and confirm a match (creating a payment + allocation per ADR-206).
- Record a manual payment and allocate it across one or more items.

Deleting a person cascades the deletion of their items and payments, gated behind a confirmation dialog — mirroring the existing `DebtsSection` delete-confirm pattern. The section reuses the existing `AccountsPage` layout conventions and `ResponsiveModal` for create/edit forms. A new i18n namespace is added with full English/Spanish parity (ADR-100/101). In-app displayed amounts use es-AR grouping per the domain-constant rule (ADR-102) — this applies only to in-app UI; the exported PDF (ADR-209) is a deliberate, separate exception.

## Alternatives Considered

- **Dedicated top-level nav page for Receivables**: would give the feature more visual prominence and room to grow, but breaks the established nav-minimization pattern (ADR-127/172) and separates the two conceptually-paired "debt" sections (owed-by-me vs owed-to-me) that benefit from being adjacent — rejected for v1; can be revisited if the feature grows substantially.

## Consequences

- No new top-level navigation item; reuses `AccountsPage` and `ResponsiveModal` component patterns already established for Debts/Accounts.
- New i18n namespace needs translation-parity tests (mirroring existing namespace test coverage per ADR-100/101).
- The person-delete cascade confirm dialog needs equivalent test coverage to `DebtsSection`'s existing delete-confirm tests.
- Relates to ADR-127/172 (nav-minimization precedent), ADR-187 (adjacent Debts section this pairs with), ADR-100/101/102 (i18n and locale-formatting conventions), ADR-206 (settlement/warning flows surfaced here), ADR-207 (match-review UI surfaced here), ADR-209 (PDF download entry point lives in this section).

## Status History

- 2026-08-28: accepted
