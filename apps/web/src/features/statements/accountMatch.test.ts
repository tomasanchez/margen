/**
 * Unit tests for the statement-import card-account matching (ADR-184).
 *
 * Argentine credit cards carry SEPARATE ARS + USD balances (distinct accounts
 * under one card institution), so a statement's lines are matched to the card
 * account by (institution, currency): an ARS line → the issuer's ARS card
 * account, a USD line → its USD card account. These cover the pure matcher: the
 * happy dual-currency match, name tolerance, currency-not-present, no-matching
 * account (left unmatched → imports unattached), and the card-type filter (a
 * bank/wallet account of the same name is NOT a match). English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { currenciesInParse, matchCardAccounts } from './accountMatch'
import type { Account, Institution } from '../../mock/types'
import type { StatementParse } from '../../api/statementsClient'

/** A minimal account leaf for the matcher. */
function account(overrides: Partial<Account>): Account {
  return {
    id: 'acc-1',
    institutionId: 'inst-1',
    institutionName: 'Galicia',
    type: 'card',
    currency: 'ARS',
    openingBalance: '0',
    ...overrides,
  }
}

/** A parse with the given per-line currencies and a Galicia issuer. */
function parseWith(
  currencies: readonly ('ARS' | 'USD')[],
  bankName: string | undefined = 'Galicia',
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

describe('matchCardAccounts', () => {
  const arsCard = account({ id: 'ars-card', currency: 'ARS', type: 'card' })
  const usdCard = account({ id: 'usd-card', currency: 'USD', type: 'card' })

  test('matches each currency to the same-institution card account of that currency', () => {
    const matches = matchCardAccounts(parseWith(['ARS', 'USD']), [
      arsCard,
      usdCard,
    ])
    expect(matches.get('ARS')?.id).toBe('ars-card')
    expect(matches.get('USD')?.id).toBe('usd-card')
  })

  test('is tolerant of case + accents in the institution name', () => {
    const matches = matchCardAccounts(
      parseWith(['ARS'], 'galícia'),
      [account({ id: 'ars-card', institutionName: 'GALICIA', currency: 'ARS' })],
    )
    expect(matches.get('ARS')?.id).toBe('ars-card')
  })

  test('only matches currencies present in the statement', () => {
    // The statement has only ARS lines; the USD card account is not offered.
    const matches = matchCardAccounts(parseWith(['ARS']), [arsCard, usdCard])
    expect(matches.has('ARS')).toBe(true)
    expect(matches.has('USD')).toBe(false)
  })

  test('leaves a currency unmatched when no card account of that currency exists', () => {
    // Only an ARS card account exists; the USD line has no match → unattached.
    const matches = matchCardAccounts(parseWith(['ARS', 'USD']), [arsCard])
    expect(matches.get('ARS')?.id).toBe('ars-card')
    expect(matches.has('USD')).toBe(false)
  })

  test('ignores non-card accounts of the same institution name (card-type only)', () => {
    // A Galicia BANK account of the right currency is NOT a credit-card account.
    const bank = account({ id: 'ars-bank', currency: 'ARS', type: 'bank' })
    const matches = matchCardAccounts(parseWith(['ARS']), [bank])
    expect(matches.has('ARS')).toBe(false)
  })

  test('leaves everything unmatched when the parse has no bank name', () => {
    // Build a parse with no bankName at all (the default param would re-add one).
    const noBank: StatementParse = { ...parseWith(['ARS']), bankName: undefined }
    const matches = matchCardAccounts(noBank, [arsCard])
    expect(matches.size).toBe(0)
  })

  test('does not match a card account of a different institution', () => {
    const other = account({
      id: 'visa-card',
      institutionName: 'Visa Nación',
      currency: 'ARS',
      type: 'card',
    })
    const matches = matchCardAccounts(parseWith(['ARS'], 'Galicia'), [other])
    expect(matches.has('ARS')).toBe(false)
  })
})

describe('matchCardAccounts — brand + last4 identity (ADR-190)', () => {
  /** A card institution carrying the ADR-190 brand + last4 identity. */
  function cardInstitution(overrides: Partial<Institution>): Institution {
    return {
      id: 'inst-1',
      name: 'Galicia',
      type: 'card',
      brand: 'VISA',
      last4: '5771',
      ...overrides,
    }
  }

  /** A parse carrying the card identity (network + cardLast4) + a bank name. */
  function parseWithIdentity(
    network: string | undefined,
    cardLast4: string | undefined,
    bankName: string | undefined = 'Galicia',
  ): StatementParse {
    return {
      ...parseWith(['ARS']),
      ...(bankName !== undefined ? { bankName } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(cardLast4 !== undefined ? { cardLast4 } : {}),
    }
  }

  test('matches by (brand + last4) across two same-issuer cards', () => {
    // Two Galicia cards; name alone cannot tell them apart, brand+last4 can.
    const cardA = cardInstitution({ id: 'inst-a', brand: 'VISA', last4: '5771' })
    const cardB = cardInstitution({ id: 'inst-b', brand: 'AMEX', last4: '1234' })
    const acctA = account({ id: 'acc-a', institutionId: 'inst-a', currency: 'ARS' })
    const acctB = account({ id: 'acc-b', institutionId: 'inst-b', currency: 'ARS' })
    const matches = matchCardAccounts(
      parseWithIdentity('AMEX', '1234'),
      [acctA, acctB],
      [cardA, cardB],
    )
    expect(matches.get('ARS')?.id).toBe('acc-b')
  })

  test('falls back to name-only match when brand/last4 are absent (ADR-184)', () => {
    const card = cardInstitution({ id: 'inst-1', brand: null, last4: null })
    const acct = account({ id: 'acc-1', institutionId: 'inst-1', currency: 'ARS' })
    // The parse also lacks a network/last4, so only the name resolves it.
    const matches = matchCardAccounts(
      parseWithIdentity(undefined, undefined, 'Galicia'),
      [acct],
      [card],
    )
    expect(matches.get('ARS')?.id).toBe('acc-1')
  })

  test('is tolerant of brand case/spacing and non-digit last4 noise', () => {
    const card = cardInstitution({ id: 'inst-1', brand: 'visa', last4: '5771' })
    const acct = account({ id: 'acc-1', institutionId: 'inst-1', currency: 'ARS' })
    const matches = matchCardAccounts(
      parseWithIdentity('VISA', '·5771'),
      [acct],
      [card],
    )
    expect(matches.get('ARS')?.id).toBe('acc-1')
  })

  test('does not match on brand alone when last4 differs', () => {
    const card = cardInstitution({ id: 'inst-1', brand: 'VISA', last4: '0000' })
    const acct = account({ id: 'acc-1', institutionId: 'inst-1', currency: 'ARS' })
    // Different last4 and a different name → no match by identity or fallback.
    const matches = matchCardAccounts(
      parseWithIdentity('VISA', '5771', 'Santander'),
      [acct],
      [card],
    )
    expect(matches.has('ARS')).toBe(false)
  })
})
