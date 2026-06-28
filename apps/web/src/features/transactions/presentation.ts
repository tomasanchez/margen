/**
 * Small presentation helpers shared by the Transactions row and filter chips.
 * Colors resolve to design tokens (tokens.css) so they adapt to light/dark.
 *
 * Category and bank names are backend-provided enum-like strings (ADR-103). We
 * keep the raw enum value as the catalog KEY (`common:categories.<value>` /
 * `common:banks.<value>`) so the lookup is direct and an unmapped key falls
 * back to its own raw value. These resolvers localize the human-facing label
 * off the active UI language while the underlying enum stays canonical.
 */

import i18n from 'i18next'

import type { Account, Bank, Category, Transaction } from '../../mock/types'

/**
 * Color token for a category's dot. The concept tints Income with the Safe
 * green and renders every spending category in a single neutral hue; we keep
 * that, mapping to tokens rather than hex. The dot is a redundant cue beside the
 * category text label, never the only signal (ADR-019).
 */
export function categoryDotColor(category: Category): string {
  return category === 'Income' ? 'var(--mg-safe)' : 'var(--mg-text-2)'
}

/**
 * Localized label for a transaction category (ADR-103). Looks up
 * `common:categories.<value>` and falls back to the raw enum value when the key
 * is unmapped, so a new backend category renders in its English form rather than
 * a missing-key token. Non-hook util (uses the singleton i18next instance) so it
 * is callable from plain modules and inside render alike; it re-reads the active
 * language on each call, so a language switch re-resolves on the next render.
 */
export function categoryLabel(category: Category): string {
  return i18n.t(`common:categories.${category}`, { defaultValue: category })
}

/**
 * Localized label for a transaction's normalized bank (ADR-103/ADR-117). Mirrors
 * {@link categoryLabel}: looks up `common:banks.<value>` and falls back to the
 * raw enum value when unmapped. Brand names (e.g. "Galicia", "Santander") stay
 * as-is across locales; only generic values like "Transfer" localize.
 */
export function bankLabel(bank: Bank): string {
  return i18n.t(`common:banks.${bank}`, { defaultValue: bank })
}

/**
 * The calm, secondary "bank · card" detail line for a row (ADR-037/ADR-117).
 *
 * Composes the localized {@link bankLabel} with the import-set card detail when
 * present (e.g. "Santander · VISA ·5771"); when there is no card it is just the
 * bank label. The card string is a display detail provided verbatim by the
 * import (not translated). Pure (no React) so the row + tests can share it.
 */
export function bankCardLabel(
  bank: Bank,
  card: Transaction['card'],
): string {
  const detail = card?.trim()
  const base = bankLabel(bank)
  return detail ? `${base} · ${detail}` : base
}

/**
 * The calm, secondary attribution line for a transaction row (ADR-136 extension
 * of ADR-134/117).
 *
 * Attribution now comes from the LINKED ACCOUNT: when the row carries an
 * `accountId` that resolves to a known account, the account's institution name
 * is the base label (composed with the import-set `card` detail when present,
 * e.g. "Galicia · VISA ·5771"). A row with no `accountId` — or one whose account
 * is no longer in the list — FALLS BACK to the legacy `bank · card` tag
 * ({@link bankCardLabel}), covering statement-imported / not-yet-linked rows.
 *
 * `accountNames` is a precomputed `accountId → institutionName` lookup (built
 * once on the page from the loaded accounts), so resolving a row is O(1) and
 * never triggers a per-row fetch. Pure (no React) so the row + tests can share it.
 */
export function attributionLabel(
  transaction: Pick<Transaction, 'accountId' | 'bank' | 'card'>,
  accountNames: ReadonlyMap<string, string>,
): string {
  const institutionName = transaction.accountId
    ? accountNames.get(transaction.accountId)
    : undefined
  if (institutionName) {
    const detail = transaction.card?.trim()
    return detail ? `${institutionName} · ${detail}` : institutionName
  }
  // No account (or an unknown id): show the legacy bank · card display.
  return bankCardLabel(transaction.bank, transaction.card)
}

/**
 * Label for an account in the selector / Account filter (ADR-134):
 * "{institutionName} · {currency}", e.g. "Galicia · ARS". The institution name
 * is a brand string kept as-is; the currency code is a canonical identifier. Pure
 * (no React) so the form, filter, and tests can share it.
 */
export function accountOptionLabel(account: Account): string {
  return `${account.institutionName} · ${account.currency}`
}
