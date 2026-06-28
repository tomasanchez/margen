---
project: margen
adr: 136
title: Retire the Bank-tag filter on Transactions; Account is the sole attribution filter
category: ux
date: 2026-06-28
status: accepted
supersedes: null
amends: [134, 116]
authors: [Tomas Sanchez]
---

# ADR-136: Retire the Bank-tag filter on Transactions; Account is the sole attribution filter

## Context

ADR-134 introduced the Institution + Account model and an Account multi-select filter on the Transactions screen, but deliberately **retained the legacy Bank-tag filter alongside it** ("retain both ... during transition") plus a clickable `account=<id>` drilldown (extending ADR-116's URL-synced filters).

Now that transactions are attributed via `account_id` and the Account filter is the primary, accurate way to slice by source, the Bank-tag filter is redundant. Bank is a free-form-ish display tag on the row (`bank` / `card`), whereas Account is the real per-currency provider entity the user manages. Keeping two overlapping "where did this come from" filters is confusing and dilutes the Account filter the rest of the model is built around.

## Decision

Retire the Bank-tag filter from the Transactions screen. Specifically:

- Remove the desktop "BANK / CARD" multi-select and the mobile bank chip section.
- Remove `banks` from `TransactionFilters` / `DEFAULT_FILTERS`, the bank branch in `matchesFilters`, `countByBank`, and bank handling in `hasActiveFilters` / `activeFilterCount`.
- Drop the `bank` URL search param (amends ADR-116): remove it from `TransactionsSearch`, `validateTransactionsSearch`, `searchToFilters`, and `filtersToSearch`. A `bank=` param on an old shared/bookmarked link is now silently ignored (lenient validation per ADR-031).
- Remove `toggleBank` from the filter controls (hook + standalone page bundle).
- Remove the filter-only i18n labels `transactions:filters.bankLabel` and `transactions:filters.bankSection` (en + es).

**Kept intact:** the Account multi-select filter, the `account=<id>` URL param, and the account drilldown (the replacement, ADR-134); the transaction row's informational `bank · card` display and its `bankLabel` / `bankCardLabel` / `presentation` helpers; the `Bank` type and the `common:banks.*` catalog (still used for row display, guarded by the i18n parity test); the Add/Edit form's bank picker (`BANKS`, `form.bank.section`).

This amends ADR-134's "retain both during transition" clause — the transition is complete — and amends ADR-116's param set by dropping `bank`.

## Consequences

- Simpler, less ambiguous filter UI; Account is the single attribution filter.
- Old links carrying `bank=` degrade gracefully (param ignored).
- Row-level bank/card information is unaffected; users still see where a movement came from, they just filter by Account.
- Gates verified green: `pnpm lint`, `pnpm test` (449 passed), `pnpm build`, and `tsc --noEmit` clean. Bank-filter tests in `filtering.test.ts` were removed/repointed; account filter + drilldown tests still pass.
