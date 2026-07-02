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
