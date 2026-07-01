/**
 * Unit tests for the row attribution/label helpers (ADR-136 extension of
 * ADR-117/134). Attribution now comes from the LINKED ACCOUNT; the legacy `bank`
 * column is decommissioned (ADR-136), so an absent bank is the EMPTY sentinel
 * (`''`) and must NEVER render as a fabricated "Transfer".
 */

import { describe, expect, test } from 'vitest'
import { attributionLabel, bankCardLabel, bankLabel } from './presentation'
import type { Bank, Transaction } from '../../mock/types'

/** A minimal row Pick for the attribution helper. */
function row(
  over: Partial<Pick<Transaction, 'accountId' | 'bank' | 'card'>> = {},
): Pick<Transaction, 'accountId' | 'bank' | 'card'> {
  return { bank: '' as Bank, ...over }
}

describe('bankLabel', () => {
  test('an empty bank yields the empty string (no fabricated tag)', () => {
    expect(bankLabel('' as Bank)).toBe('')
  })

  test('a real brand bank localizes / falls back to its own value', () => {
    expect(bankLabel('Mercado Pago')).toBe('Mercado Pago')
  })
})

describe('bankCardLabel', () => {
  test('empty bank + no card → empty string', () => {
    expect(bankCardLabel('' as Bank, undefined)).toBe('')
  })

  test('empty bank + a card → the card alone (no leading separator)', () => {
    expect(bankCardLabel('' as Bank, 'VISA ·5771')).toBe('VISA ·5771')
  })

  test('a bank + a card → "bank · card"', () => {
    expect(bankCardLabel('Santander', 'AMEX ·1234')).toBe('Santander · AMEX ·1234')
  })
})

describe('attributionLabel', () => {
  const accountNames = new Map<string, string>([['acc-1', 'Mercado Pago']])

  test('a row with a resolvable account shows the institution name', () => {
    expect(attributionLabel(row({ accountId: 'acc-1' }), accountNames)).toBe(
      'Mercado Pago',
    )
  })

  test('a resolvable account composes with the import-set card', () => {
    expect(
      attributionLabel(
        row({ accountId: 'acc-1', card: 'VISA ·5771' }),
        accountNames,
      ),
    ).toBe('Mercado Pago · VISA ·5771')
  })

  test('a row with NEITHER a resolvable account NOR a real bank shows nothing (never "Transfer")', () => {
    // The common case now that the bank column is retired (ADR-136): no account
    // id and an empty bank → empty label, so the row shows just its category.
    expect(attributionLabel(row(), accountNames)).toBe('')
    // An accountId that isn't in the map also falls back to the empty bank.
    expect(
      attributionLabel(row({ accountId: 'unknown' }), accountNames),
    ).toBe('')
    // And it must not be the fabricated legacy tag.
    expect(attributionLabel(row(), accountNames)).not.toBe('Transfer')
  })

  test('a genuine legacy bank tag still renders (only real values, ADR-136)', () => {
    expect(attributionLabel(row({ bank: 'Galicia' }), accountNames)).toBe(
      'Galicia',
    )
  })
})
