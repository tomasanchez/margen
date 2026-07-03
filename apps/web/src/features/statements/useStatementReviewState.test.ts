/**
 * Unit tests for the statement review-state cuota helpers (ADR-175).
 *
 * The parser detects a `Cuota N/M` marker as a free-text string; the review UI
 * surfaces it as an editable index/total pair and recomposes the string, which the
 * backend re-parses into structured installment fields on import (ADR-175/176).
 * These tests cover the pure `parseCuota` / `formatCuota` helpers (the parse/format
 * boundary) and the `setCuota` reducer via a rendered hook: editing a line's
 * index/total updates its `cuota` and flows through `buildImportRequest`.
 * English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  formatCuota,
  parseCuota,
  useStatementReviewState,
} from './useStatementReviewState'
import type { StatementParse } from '../../api/statementsClient'
import type { Account } from '../../mock/types'

describe('parseCuota', () => {
  test('parses a "N/M" marker into positive integers', () => {
    expect(parseCuota('3/12')).toEqual({ index: 3, total: 12 })
    expect(parseCuota('03/06')).toEqual({ index: 3, total: 6 })
    expect(parseCuota(' 1 / 4 ')).toEqual({ index: 1, total: 4 })
  })

  test('yields nulls for a blank / malformed / non-positive marker', () => {
    expect(parseCuota(undefined)).toEqual({ index: null, total: null })
    expect(parseCuota('')).toEqual({ index: null, total: null })
    expect(parseCuota('3')).toEqual({ index: null, total: null })
    expect(parseCuota('3/0')).toEqual({ index: 3, total: null })
    expect(parseCuota('3.5/12')).toEqual({ index: null, total: 12 })
  })
})

describe('formatCuota', () => {
  test('rebuilds a complete valid pair', () => {
    expect(formatCuota(3, 12)).toBe('3/12')
  })

  test('drops an incomplete or invalid pair', () => {
    expect(formatCuota(null, 12)).toBeUndefined()
    expect(formatCuota(3, null)).toBeUndefined()
    // Index must not exceed the total.
    expect(formatCuota(13, 12)).toBeUndefined()
    expect(formatCuota(0, 12)).toBeUndefined()
  })
})

/** A minimal parse with one installment line the review state seeds from. */
function parse(): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    bankName: 'Galicia',
    card: 'VISA ·5771',
    naturalKey: null,
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
    lines: [
      {
        id: '0',
        occurredOn: '2026-06-10',
        name: 'Samsung TV',
        amount: 30000,
        currency: 'ARS',
        cuota: '3/12',
        lineKind: 'purchase',
        include: true,
      },
    ],
  }
}

describe('useStatementReviewState.setCuota', () => {
  test('editing the index/total recomposes cuota into the import request', () => {
    const { result } = renderHook(() => useStatementReviewState(parse()))

    // The seeded line carries the parsed marker.
    expect(result.current.lines[0].cuota).toBe('3/12')

    // Correct a misparse: 4 of 12.
    act(() => result.current.setCuota('0', 4, 12))
    expect(result.current.lines[0].cuota).toBe('4/12')

    const request = result.current.buildImportRequest()
    expect(request.lines[0].cuota).toBe('4/12')
  })

  test('an invalid pair clears the marker so no malformed cuota is sent', () => {
    const { result } = renderHook(() => useStatementReviewState(parse()))

    // Index exceeds total → the marker is cleared.
    act(() => result.current.setCuota('0', 13, 12))
    expect(result.current.lines[0].cuota).toBeUndefined()

    const request = result.current.buildImportRequest()
    expect('cuota' in request.lines[0]).toBe(false)
  })
})

/** A card-account leaf under a named institution + currency (ADR-134/184). */
function cardAccount(overrides: Partial<Account>): Account {
  return {
    id: 'acc',
    institutionId: 'inst-1',
    institutionName: 'Galicia',
    type: 'card',
    currency: 'ARS',
    openingBalance: '0',
    ...overrides,
  }
}

/** A dual-currency (ARS + USD) parse from a Galicia card. */
function dualCurrencyParse(): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    bankName: 'Galicia',
    card: 'VISA ·5771',
    naturalKey: null,
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
    lines: [
      {
        id: '0',
        occurredOn: '2026-06-10',
        name: 'Carrefour',
        amount: 45000,
        currency: 'ARS',
        lineKind: 'purchase',
        include: true,
      },
      {
        id: '1',
        occurredOn: '2026-06-10',
        name: 'Spotify',
        amount: 12,
        currency: 'USD',
        lineKind: 'purchase',
        include: true,
      },
    ],
  }
}

describe('useStatementReviewState — card-account attachment (ADR-184)', () => {
  const arsCard = cardAccount({ id: 'ars-card', currency: 'ARS' })
  const usdCard = cardAccount({ id: 'usd-card', currency: 'USD' })

  test('auto-matches each line-currency to its (institution, currency) card account and stamps accountId per line', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [arsCard, usdCard]),
    )

    // A per-currency choice is seeded, defaulting to the auto-matched account.
    const choices = result.current.accountChoices
    expect(choices.map((c) => c.currency)).toEqual(['ARS', 'USD'])
    expect(choices[0].selectedAccountId).toBe('ars-card')
    expect(choices[1].selectedAccountId).toBe('usd-card')

    // Each line's accountId follows its currency in the import request.
    const request = result.current.buildImportRequest()
    const carrefour = request.lines.find((l) => l.name === 'Carrefour')
    const spotify = request.lines.find((l) => l.name === 'Spotify')
    expect(carrefour?.accountId).toBe('ars-card')
    expect(spotify?.accountId).toBe('usd-card')
  })

  test('leaves an unmatched currency unattached (no accountId sent)', () => {
    // Only an ARS card account exists — the USD line stays unattached (ADR-184).
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [arsCard]),
    )

    const usdChoice = result.current.accountChoices.find(
      (c) => c.currency === 'USD',
    )
    expect(usdChoice?.matched).toBeNull()
    expect(usdChoice?.selectedAccountId).toBeNull()

    const request = result.current.buildImportRequest()
    const spotify = request.lines.find((l) => l.name === 'Spotify')
    expect('accountId' in (spotify ?? {})).toBe(false)
  })

  test('a user override replaces the auto-match for that currency', () => {
    const otherArsCard = cardAccount({ id: 'ars-card-2', currency: 'ARS' })
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [
        arsCard,
        otherArsCard,
        usdCard,
      ]),
    )

    // Override the ARS section to the second ARS card.
    act(() => result.current.setAccountForCurrency('ARS', 'ars-card-2'))
    const request = result.current.buildImportRequest()
    const carrefour = request.lines.find((l) => l.name === 'Carrefour')
    expect(carrefour?.accountId).toBe('ars-card-2')

    // Clearing to null imports that currency's lines unattached.
    act(() => result.current.setAccountForCurrency('ARS', null))
    const cleared = result.current.buildImportRequest()
    const carrefour2 = cleared.lines.find((l) => l.name === 'Carrefour')
    expect('accountId' in (carrefour2 ?? {})).toBe(false)
    // The USD line is untouched by the ARS override.
    const spotify = cleared.lines.find((l) => l.name === 'Spotify')
    expect(spotify?.accountId).toBe('usd-card')
  })

  test('re-seeds the default from the auto-match once the accounts list resolves', () => {
    // Accounts start empty (loading), then resolve — the selection should adopt
    // the auto-match without a user action (rerender with the resolved list).
    const { result, rerender } = renderHook(
      ({ accounts }: { accounts: Account[] }) =>
        useStatementReviewState(dualCurrencyParse(), accounts),
      { initialProps: { accounts: [] as Account[] } },
    )

    expect(result.current.accountChoices[0].selectedAccountId).toBeNull()

    rerender({ accounts: [arsCard, usdCard] })
    expect(result.current.accountChoices[0].selectedAccountId).toBe('ars-card')
    expect(result.current.accountChoices[1].selectedAccountId).toBe('usd-card')
  })
})
