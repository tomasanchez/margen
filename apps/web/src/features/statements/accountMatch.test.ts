/**
 * Unit tests for the statement-import account matching (ADR-198).
 *
 * ADR-198 imports credit-card charges as ordinary expenses on the user's NON-card
 * money accounts — card charges are spend the user pays off by moving money
 * between their own bank accounts, reconciled manually — so a statement's lines are
 * matched to a bank / cash / wallet account by (issuer name, currency): an ARS line
 * → the issuer's ARS bank account, a USD line → its USD bank account. CARD-type
 * accounts are excluded (the card modelling is dormant). These cover the pure
 * matcher: the happy dual-currency match, name tolerance, currency-not-present, the
 * non-card filter (a same-name card account is NOT a match), no matching account
 * (left unmatched → picker / imports unattached), deterministic disambiguation when
 * multiple same-name same-currency accounts exist (largest balance first), and the
 * no-issuer-name guard. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { currenciesInParse, matchAccounts } from './accountMatch'
import type { Account } from '../../mock/types'
import type { StatementParse } from '../../api/statementsClient'

/** A minimal account leaf for the matcher (defaults to a Santander ARS bank). */
function account(overrides: Partial<Account>): Account {
  return {
    id: 'acc-1',
    institutionId: 'inst-1',
    institutionName: 'Santander',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '0',
    ...overrides,
  }
}

/** A parse with the given per-line currencies and a Santander issuer. */
function parseWith(
  currencies: readonly ('ARS' | 'USD')[],
  bankName: string | undefined = 'Santander',
): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    ...(bankName !== undefined ? { bankName } : {}),
    naturalKey: null,
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
    lines: currencies.map((currency, i) => ({
      id: String(i),
      occurredOn: '2026-06-10',
      name: `Line ${i}`,
      amount: 1000,
      currency,
      lineKind: 'purchase' as const,
      include: true,
    })),
  }
}

describe('currenciesInParse', () => {
  test('returns the distinct line currencies, ARS before USD', () => {
    expect(currenciesInParse(parseWith(['USD', 'ARS', 'ARS']))).toEqual([
      'ARS',
      'USD',
    ])
    expect(currenciesInParse(parseWith(['USD']))).toEqual(['USD'])
    expect(currenciesInParse(parseWith([]))).toEqual([])
  })
})

describe('matchAccounts', () => {
  const arsBank = account({ id: 'ars-bank', currency: 'ARS', type: 'bank' })
  const usdBank = account({ id: 'usd-bank', currency: 'USD', type: 'bank' })

  test('matches each currency to the same-issuer NON-card account of that currency', () => {
    // A Santander statement attaches ARS charges to the Santander bank ARS account
    // and USD charges to the Santander bank USD account (ADR-198).
    const matches = matchAccounts(parseWith(['ARS', 'USD']), [arsBank, usdBank])
    expect(matches.get('ARS')?.id).toBe('ars-bank')
    expect(matches.get('USD')?.id).toBe('usd-bank')
  })

  test('matches cash / wallet accounts too, not just banks', () => {
    const cash = account({ id: 'cash', currency: 'ARS', type: 'cash' })
    const wallet = account({ id: 'wallet', currency: 'USD', type: 'wallet' })
    const matches = matchAccounts(parseWith(['ARS', 'USD']), [cash, wallet])
    expect(matches.get('ARS')?.id).toBe('cash')
    expect(matches.get('USD')?.id).toBe('wallet')
  })

  test('is tolerant of case + accents in the issuer name', () => {
    const matches = matchAccounts(parseWith(['ARS'], 'galícia'), [
      account({ id: 'ars-bank', institutionName: 'GALICIA', currency: 'ARS' }),
    ])
    expect(matches.get('ARS')?.id).toBe('ars-bank')
  })

  test('only matches currencies present in the statement', () => {
    // The statement has only ARS lines; the USD account is not offered.
    const matches = matchAccounts(parseWith(['ARS']), [arsBank, usdBank])
    expect(matches.has('ARS')).toBe(true)
    expect(matches.has('USD')).toBe(false)
  })

  test('leaves a currency unmatched when no account of that currency exists', () => {
    // Only an ARS bank account exists; the USD line has no match → unattached.
    const matches = matchAccounts(parseWith(['ARS', 'USD']), [arsBank])
    expect(matches.get('ARS')?.id).toBe('ars-bank')
    expect(matches.has('USD')).toBe(false)
  })

  test('EXCLUDES card-type accounts of the same issuer name (non-card only)', () => {
    // A Santander CARD account of the right currency is NOT a candidate (ADR-198):
    // charges import onto a real money account, never a card pseudo-account.
    const card = account({ id: 'ars-card', currency: 'ARS', type: 'card' })
    const matches = matchAccounts(parseWith(['ARS']), [card])
    expect(matches.has('ARS')).toBe(false)
  })

  test('prefers the non-card account when a same-name card account also exists', () => {
    const card = account({ id: 'ars-card', currency: 'ARS', type: 'card' })
    const bank = account({ id: 'ars-bank', currency: 'ARS', type: 'bank' })
    const matches = matchAccounts(parseWith(['ARS']), [card, bank])
    expect(matches.get('ARS')?.id).toBe('ars-bank')
  })

  test('leaves everything unmatched when the parse has no issuer name', () => {
    const noBank: StatementParse = { ...parseWith(['ARS']), bankName: undefined }
    const matches = matchAccounts(noBank, [arsBank])
    expect(matches.size).toBe(0)
  })

  test('does not match an account of a different issuer', () => {
    const other = account({
      id: 'galicia-bank',
      institutionName: 'Galicia',
      currency: 'ARS',
      type: 'bank',
    })
    const matches = matchAccounts(parseWith(['ARS'], 'Santander'), [other])
    expect(matches.has('ARS')).toBe(false)
  })

  test('disambiguates multiple same-name same-currency accounts by largest balance', () => {
    // Two Santander ARS bank accounts: the larger-balance one is the default.
    const small = account({
      id: 'ars-small',
      currency: 'ARS',
      type: 'bank',
      openingBalance: '10000',
    })
    const large = account({
      id: 'ars-large',
      currency: 'ARS',
      type: 'bank',
      openingBalance: '500000',
    })
    const matches = matchAccounts(parseWith(['ARS']), [small, large])
    expect(matches.get('ARS')?.id).toBe('ars-large')
  })
})
