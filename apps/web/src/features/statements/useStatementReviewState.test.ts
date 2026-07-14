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

/** A non-card money-account leaf under a named institution + currency (ADR-198). */
function bankAccount(overrides: Partial<Account>): Account {
  return {
    id: 'acc',
    institutionId: 'inst-1',
    institutionName: 'Galicia',
    type: 'bank',
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

/** A parse with a USD-only line (no peso amount) + an ARS line (ADR-079). */
function usdOnlyParse(): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    bankName: 'Santander',
    card: 'AMEX ·1234',
    naturalKey: null,
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
    lines: [
      {
        id: '0',
        occurredOn: '2026-06-10',
        name: 'Coto',
        amount: 45000,
        currency: 'ARS',
        lineKind: 'purchase',
        include: true,
      },
      {
        // A USD-only card charge: usdAmount set, amount 0, no FX (left for review).
        id: '1',
        occurredOn: '2026-06-10',
        name: 'AWS',
        amount: 0,
        currency: 'USD',
        usdAmount: 200,
        lineKind: 'purchase',
        include: true,
      },
    ],
  }
}

describe('useStatementReviewState — USD-only line materialization (ADR-079/148/149)', () => {
  test('materializes amount = usdAmount × rate + fxRate/fxRateType, imports amount > 0', () => {
    const { result } = renderHook(() =>
      // rate 1245 (ARS per USD), preferred source 'bolsa' → fxRateType 'MEP'.
      useStatementReviewState(usdOnlyParse(), [], 1245, 'bolsa'),
    )

    const usd = result.current.lines.find((l) => l.name === 'AWS')
    expect(usd?.amount).toBe(200 * 1245)
    expect(usd?.fxRate).toBe(1245)
    expect(usd?.fxRateType).toBe('MEP')
    // The rate resolved, so no unavailable hint.
    expect(result.current.usdRateUnavailable).toBe(false)

    const request = result.current.buildImportRequest()
    const awsLine = request.lines.find((l) => l.name === 'AWS')
    expect(awsLine?.amount).toBe(String(200 * 1245))
    expect(awsLine?.usdAmount).toBe('200')
    expect(awsLine?.fxRate).toBe('1245')
    expect(awsLine?.fxRateType).toBe('MEP')
    // The FX provenance travels WITH the rate so the row's snapshot is complete
    // (ADR-148) and the backend re-materializes usd_amount (only fires when
    // fx_source is set). 'bolsa' preferred source → 'bolsa' provenance; NEVER hardcoded
    // 'manual'.
    expect(awsLine?.fxSource).toBe('bolsa')
  })

  test('a materialized USD line sends fxSource = the preferred source (oficial), never manual', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], 1050, 'oficial'),
    )
    const request = result.current.buildImportRequest()
    const awsLine = request.lines.find((l) => l.name === 'AWS')
    // The line's ARS-equivalent materialized, so the FX snapshot is complete: the
    // rate, family AND provenance all travel to the backend.
    expect(awsLine?.fxRate).toBe('1050')
    expect(awsLine?.fxRateType).toBe('official')
    expect(awsLine?.fxSource).toBe('oficial')
    expect(awsLine?.fxSource).not.toBe('manual')
  })

  test('tags fxRateType official when the preferred source is oficial', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], 1050, 'oficial'),
    )
    const usd = result.current.lines.find((l) => l.name === 'AWS')
    expect(usd?.amount).toBe(200 * 1050)
    expect(usd?.fxRateType).toBe('official')
  })

  test('materializes once the rate resolves (was null on first render) without a re-seed clobber', () => {
    const { result, rerender } = renderHook(
      ({ rate }: { rate: number | null }) =>
        useStatementReviewState(usdOnlyParse(), [], rate, 'bolsa'),
      { initialProps: { rate: null as number | null } },
    )

    // Rate not yet available: the USD line stays at amount 0 and the hint shows.
    expect(result.current.lines.find((l) => l.name === 'AWS')?.amount).toBe(0)
    expect(result.current.usdRateUnavailable).toBe(true)

    // The rate lands — the USD line materializes.
    rerender({ rate: 1245 })
    const usd = result.current.lines.find((l) => l.name === 'AWS')
    expect(usd?.amount).toBe(200 * 1245)
    expect(usd?.fxRate).toBe(1245)
    expect(result.current.usdRateUnavailable).toBe(false)
  })

  test('does NOT overwrite a USD line that already carries a positive peso amount', () => {
    const parseWithPeso = usdOnlyParse()
    // A Santander AMEX line that DID carry a peso column: amount already set.
    parseWithPeso.lines[1] = {
      ...parseWithPeso.lines[1],
      amount: 260000,
    }
    const { result } = renderHook(() =>
      useStatementReviewState(parseWithPeso, [], 1245, 'bolsa'),
    )
    const usd = result.current.lines.find((l) => l.name === 'AWS')
    // Left as-is — not recomputed to 200 × 1245.
    expect(usd?.amount).toBe(260000)
    expect(usd?.fxRate).toBeUndefined()
  })

  test('leaves ARS lines untouched by the USD materialization', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], 1245, 'bolsa'),
    )
    const ars = result.current.lines.find((l) => l.name === 'Coto')
    expect(ars?.amount).toBe(45000)
    expect(ars?.fxRate).toBeUndefined()
    expect(ars?.fxRateType).toBeUndefined()
  })

  test('rate unavailable: leaves amount 0, no fabricated rate, sets the hint', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], null, 'bolsa'),
    )
    const usd = result.current.lines.find((l) => l.name === 'AWS')
    expect(usd?.amount).toBe(0)
    expect(usd?.fxRate).toBeUndefined()
    expect(usd?.fxRateType).toBeUndefined()
    expect(result.current.usdRateUnavailable).toBe(true)
  })

  test('a user-entered ARS amount is not clobbered when the rate later lands', () => {
    const { result, rerender } = renderHook(
      ({ rate }: { rate: number | null }) =>
        useStatementReviewState(usdOnlyParse(), [], rate, 'bolsa'),
      { initialProps: { rate: null as number | null } },
    )

    // The user hand-enters an ARS amount while the rate is unavailable.
    act(() => result.current.setAmount('1', 300000))
    expect(result.current.lines.find((l) => l.name === 'AWS')?.amount).toBe(300000)

    // The rate lands — the hand-edit wins; materialization does NOT overwrite it.
    rerender({ rate: 1245 })
    expect(result.current.lines.find((l) => l.name === 'AWS')?.amount).toBe(300000)
  })
})

describe('useStatementReviewState — account attachment (ADR-198)', () => {
  // The charges attach to the issuer's NON-card money accounts (ADR-198): a Galicia
  // statement's ARS lines land on the Galicia bank ARS account, USD on the USD one.
  const arsBank = bankAccount({ id: 'ars-bank', currency: 'ARS' })
  const usdBank = bankAccount({ id: 'usd-bank', currency: 'USD' })

  test('auto-matches each line-currency to its (issuer, currency) non-card account and stamps accountId per line', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [arsBank, usdBank]),
    )

    // A per-currency choice is seeded, defaulting to the auto-matched account.
    const choices = result.current.accountChoices
    expect(choices.map((c) => c.currency)).toEqual(['ARS', 'USD'])
    expect(choices[0].selectedAccountId).toBe('ars-bank')
    expect(choices[1].selectedAccountId).toBe('usd-bank')

    // Each line's accountId follows its currency in the import request.
    const request = result.current.buildImportRequest()
    const carrefour = request.lines.find((l) => l.name === 'Carrefour')
    const spotify = request.lines.find((l) => l.name === 'Spotify')
    expect(carrefour?.accountId).toBe('ars-bank')
    expect(spotify?.accountId).toBe('usd-bank')
  })

  test('a same-name CARD account is NOT a candidate; the currency stays unmatched (ADR-198)', () => {
    // The user holds only a Galicia CARD account for USD — card accounts are
    // excluded, so the USD line has no default and imports unattached.
    const usdCard = bankAccount({ id: 'usd-card', currency: 'USD', type: 'card' })
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [arsBank, usdCard]),
    )

    const usdChoice = result.current.accountChoices.find(
      (c) => c.currency === 'USD',
    )
    expect(usdChoice?.matched).toBeNull()
    expect(usdChoice?.selectedAccountId).toBeNull()
  })

  test('leaves an unmatched currency unattached (no accountId sent)', () => {
    // Only an ARS account exists — the USD line stays unattached (ADR-198).
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [arsBank]),
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
    const otherArsBank = bankAccount({ id: 'ars-bank-2', currency: 'ARS' })
    const { result } = renderHook(() =>
      useStatementReviewState(dualCurrencyParse(), [
        arsBank,
        otherArsBank,
        usdBank,
      ]),
    )

    // Override the ARS section to the second ARS account.
    act(() => result.current.setAccountForCurrency('ARS', 'ars-bank-2'))
    const request = result.current.buildImportRequest()
    const carrefour = request.lines.find((l) => l.name === 'Carrefour')
    expect(carrefour?.accountId).toBe('ars-bank-2')

    // Clearing to null imports that currency's lines unattached.
    act(() => result.current.setAccountForCurrency('ARS', null))
    const cleared = result.current.buildImportRequest()
    const carrefour2 = cleared.lines.find((l) => l.name === 'Carrefour')
    expect('accountId' in (carrefour2 ?? {})).toBe(false)
    // The USD line is untouched by the ARS override.
    const spotify = cleared.lines.find((l) => l.name === 'Spotify')
    expect(spotify?.accountId).toBe('usd-bank')
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

    rerender({ accounts: [arsBank, usdBank] })
    expect(result.current.accountChoices[0].selectedAccountId).toBe('ars-bank')
    expect(result.current.accountChoices[1].selectedAccountId).toBe('usd-bank')
  })
})

describe('useStatementReviewState — blocking zero amount (ADR-079)', () => {
  test('a kept USD line at amount 0 (rate unavailable) blocks import until an amount is entered', () => {
    const { result, rerender } = renderHook(
      ({ rate }: { rate: number | null }) =>
        useStatementReviewState(usdOnlyParse(), [], rate, 'bolsa'),
      { initialProps: { rate: null as number | null } },
    )

    // Rate unavailable: the kept USD line stays at amount 0 → import is blocked so
    // the calm inline hint (not a 422) surfaces.
    expect(result.current.usdRateUnavailable).toBe(true)
    expect(result.current.hasBlockingZeroAmount).toBe(true)

    // Hand-entering a positive ARS amount clears the block → import re-enabled.
    act(() => result.current.setAmount('1', 260000))
    expect(result.current.hasBlockingZeroAmount).toBe(false)

    // Re-checking after the rate later lands keeps it enabled (hand-edit wins).
    rerender({ rate: 1245 })
    expect(result.current.hasBlockingZeroAmount).toBe(false)
  })

  test('excluding the zero-amount line also clears the block', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], null, 'bolsa'),
    )
    expect(result.current.hasBlockingZeroAmount).toBe(true)

    // Skipping the problematic USD line removes it from the kept set → not blocking.
    act(() => result.current.toggleKeep('1', false))
    expect(result.current.hasBlockingZeroAmount).toBe(false)
  })

  test('no block when the rate materializes every kept line to a positive amount', () => {
    const { result } = renderHook(() =>
      useStatementReviewState(usdOnlyParse(), [], 1245, 'bolsa'),
    )
    // Both lines carry positive amounts (ARS parsed, USD materialized).
    expect(result.current.hasBlockingZeroAmount).toBe(false)
  })
})
