/**
 * Statement-import card-account matching (ADR-184).
 *
 * Pure, React-free deduction of which of the user's CARD accounts an imported
 * statement's lines attach to. Argentine credit cards carry SEPARATE peso and
 * dólar balances — each is a distinct per-currency {@link Account} under one card
 * institution (e.g. "Galicia" with an ARS account and a USD account) — so the
 * match is keyed by **(institution, currency)**: an ARS line attaches to the
 * issuer's ARS card account, a USD line to its USD card account (ADR-184).
 *
 * The statement parse exposes `bankName` (normalized issuer), `issuerCuit`, and
 * `cardLast4`. We can't see the CUIT/last4 on an {@link Account} (the account
 * model has no card-number field), so the institution is resolved by NAME:
 * the card-type account whose `institutionName` matches the parsed `bankName`.
 * When the parse carries no bank name, or the user has no card account for that
 * institution + currency, the currency is left UNMATCHED (the line imports
 * unattached — backend-tolerant, ADR-184).
 *
 * Money/identity strings only; no UI, no i18n. The review UI seeds its per-
 * currency default selection from {@link matchCardAccounts} and lets the user
 * confirm/override before import.
 */

import type { Account, Currency } from '../../mock/types'
import type { StatementParse } from '../../api/statementsClient'

/** A resolved card account offered as the default for one currency section. */
export interface AccountMatch {
  /** The matched account's id — the value stamped onto that currency's lines. */
  id: string
  /** The owning institution's display name, e.g. "Galicia". */
  institutionName: string
  /** The account's native currency (ARS / USD) — must equal the line currency. */
  currency: Currency
}

/**
 * Normalize an institution / bank name for tolerant comparison: trimmed,
 * case-folded, and accent-stripped so "Galicia" matches "GALICIA" / "galicia".
 * A `null`/absent name normalizes to the empty string (never matches).
 */
function normalizeName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/**
 * The card accounts the user holds under the institution named by the parse's
 * `bankName`, indexed by currency. Only `type === 'card'` accounts are eligible
 * (ADR-184: a statement charge belongs to a credit-card account, never a bank /
 * cash / wallet leaf). When two card accounts share the institution + currency
 * (shouldn't normally happen), the FIRST in list order wins — deterministic.
 */
function cardAccountsByCurrency(
  accounts: readonly Account[],
  bankName: string | null | undefined,
): Map<Currency, Account> {
  const target = normalizeName(bankName)
  const byCurrency = new Map<Currency, Account>()
  if (target === '') return byCurrency
  for (const account of accounts) {
    if (account.type !== 'card') continue
    if (normalizeName(account.institutionName) !== target) continue
    if (!byCurrency.has(account.currency)) byCurrency.set(account.currency, account)
  }
  return byCurrency
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
 * Auto-match each line-currency present in the parse to the user's card account
 * for the parsed institution + that currency (ADR-184). Returns a map keyed by
 * currency; a currency with no matching card account is ABSENT from the map (the
 * UI shows it unmatched, and its lines import unattached). Pure + deterministic.
 *
 * @param parse The successful statement parse (its `bankName` names the issuer).
 * @param accounts The user's account list (card leaves are the match candidates).
 */
export function matchCardAccounts(
  parse: StatementParse,
  accounts: readonly Account[],
): Map<Currency, AccountMatch> {
  const byCurrency = cardAccountsByCurrency(accounts, parse.bankName)
  const matches = new Map<Currency, AccountMatch>()
  for (const currency of currenciesInParse(parse)) {
    const account = byCurrency.get(currency)
    if (!account) continue
    matches.set(currency, {
      id: account.id,
      institutionName: account.institutionName,
      currency: account.currency,
    })
  }
  return matches
}
