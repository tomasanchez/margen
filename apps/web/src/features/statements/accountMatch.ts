/**
 * Statement-import account matching (ADR-184, superseded by ADR-198).
 *
 * Pure, React-free deduction of which of the user's NON-card money accounts an
 * imported statement's lines attach to. ADR-198 stopped modelling a credit card
 * as its own pseudo-account: a card charge is ordinary spend the user pays off by
 * moving money between their own bank accounts, reconciled manually. So the
 * importer attaches each charge as a plain `kind=expense` on a real bank / cash /
 * wallet account — never a card account. The parsed card identity ("VISA ·1041")
 * is preserved on the line's `card` field for reference (ADR-117), but it no
 * longer routes the attachment.
 *
 * Argentine accounts carry SEPARATE peso and dólar balances — each is a distinct
 * per-currency {@link Account} under one institution (e.g. "Santander" with an ARS
 * account and a USD account) — so the match is keyed by **(issuer name, currency)**:
 * an ARS line attaches to the issuer's ARS bank account, a USD line to its USD bank
 * account. The statement's `bankName` is matched against the account's
 * `institutionName` (accent/case tolerant). CARD-type accounts are EXCLUDED — the
 * card modelling is dormant (ADR-198); only bank / cash / wallet accounts are
 * candidates.
 *
 * Resolution per currency:
 *   1. Gather the user's NON-card accounts of that currency whose institution name
 *      matches the parse's issuer.
 *   2. Exactly one → it.
 *   3. Multiple same-name same-currency accounts → pick deterministically: largest
 *      opening balance first, institution name then id as stable tie-breaks.
 *   4. Zero → the currency is left UNMATCHED (absent from the map). The review shows
 *      a normal account picker so the user chooses one; if they don't, the lines
 *      import unattached (backend-tolerant, ADR-184). NO "register card" prompt.
 *
 * Money/identity strings only; no UI, no i18n. The review UI seeds its per-currency
 * default selection from {@link matchAccounts} and lets the user confirm / override
 * (over the full non-card account set) before import.
 */

import type { Account, Currency } from '../../mock/types'
import type { StatementParse } from '../../api/statementsClient'

/** A resolved account offered as the default for one currency section. */
export interface AccountMatch {
  /** The matched account's id — the value stamped onto that currency's lines. */
  id: string
  /** The owning institution's display name, e.g. "Santander". */
  institutionName: string
  /** The account's native currency (ARS / USD) — must equal the line currency. */
  currency: Currency
}

/**
 * Normalize an institution / bank name for tolerant comparison: trimmed,
 * case-folded, and accent-stripped so "Santander" matches "SANTANDER". A
 * `null`/absent name normalizes to the empty string (never matches).
 */
function normalizeName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** Parse an account's opening balance to a finite number (0 on garbage). */
function openingBalanceNumber(account: Account): number {
  const value = Number.parseFloat(account.openingBalance)
  return Number.isFinite(value) ? value : 0
}

/**
 * The set of line currencies present in a parse (ARS and/or USD). Only these
 * need a default selection — a statement with no USD line shows no USD section.
 */
export function currenciesInParse(parse: StatementParse): Currency[] {
  const seen = new Set<Currency>()
  for (const line of parse.lines) seen.add(line.currency)
  // Deterministic ARS-before-USD order for a stable section layout.
  return (['ARS', 'USD'] as const).filter((c) => seen.has(c))
}

/**
 * Choose the default NON-card account for one currency by issuer name (ADR-198).
 * Filters to bank / cash / wallet accounts whose institution name matches the
 * parse's issuer and whose currency equals the section currency, then picks
 * deterministically: largest opening balance first, institution name then id as
 * stable tie-breaks. Returns null when no such account exists (unmatched → picker).
 */
function chooseAccountForCurrency(
  parse: StatementParse,
  accounts: readonly Account[],
  currency: Currency,
): Account | null {
  const issuer = normalizeName(parse.bankName)
  if (issuer === '') return null
  const candidates = accounts.filter(
    (account) =>
      account.type !== 'card' &&
      account.currency === currency &&
      normalizeName(account.institutionName) === issuer,
  )
  if (candidates.length === 0) return null
  // Deterministic: largest opening balance first, then name, then id.
  return [...candidates].sort(
    (a, b) =>
      openingBalanceNumber(b) - openingBalanceNumber(a) ||
      a.institutionName.localeCompare(b.institutionName) ||
      a.id.localeCompare(b.id),
  )[0]
}

/**
 * Auto-match each line-currency present in the parse to the user's NON-card
 * account for the statement's issuer + that currency (ADR-198). Returns a map
 * keyed by currency; a currency with no matching account is ABSENT from the map
 * (the review shows a picker over the user's non-card accounts, and any unpicked
 * currency's lines import unattached). Pure + deterministic.
 *
 * @param parse The successful statement parse (its `bankName` names the issuer).
 * @param accounts The user's account list (non-card leaves are the match candidates).
 */
export function matchAccounts(
  parse: StatementParse,
  accounts: readonly Account[],
): Map<Currency, AccountMatch> {
  const matches = new Map<Currency, AccountMatch>()
  for (const currency of currenciesInParse(parse)) {
    const account = chooseAccountForCurrency(parse, accounts, currency)
    if (!account) continue
    matches.set(currency, {
      id: account.id,
      institutionName: account.institutionName,
      currency: account.currency,
    })
  }
  return matches
}
