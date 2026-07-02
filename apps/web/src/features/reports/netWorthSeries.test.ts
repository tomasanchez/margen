/**
 * Unit tests for the net-worth series conversion (ADR-164).
 *
 * The endpoint returns NATIVE per-currency subtotals with no FX; these pure
 * helpers convert each month to ONE display-currency figure at the single live
 * rate the snapshot uses. Assert: same-currency-only months need no rate;
 * cross-currency months convert at the rate (USD→ARS multiplies, ARS→USD
 * divides); a missing rate degrades a cross-currency month to `null` (never
 * fabricated); and the "any converted" guard reflects that degrade.
 */

import { describe, expect, test } from 'vitest'
import {
  convertHistoryPoint,
  convertNetWorthSeries,
  hasAnyConvertedValue,
} from './netWorthSeries'
import type { NetWorthHistoryPoint } from '../../api/reportsClient'

const point = (
  month: string,
  arsTotal: number,
  usdTotal: number,
): NetWorthHistoryPoint => ({ month, arsTotal, usdTotal })

describe('convertHistoryPoint', () => {
  test('ARS display + only ARS balance needs no rate', () => {
    const result = convertHistoryPoint(point('2026-01', 1000, 0), 'ARS', null)
    expect(result).toEqual({ month: '2026-01', value: 1000 })
  })

  test('ARS display converts a USD balance at the rate (USD→ARS multiplies)', () => {
    const result = convertHistoryPoint(point('2026-01', 1000, 10), 'ARS', 1200)
    // 1000 ARS + 10 USD × 1200 = 13000 ARS.
    expect(result.value).toBe(13_000)
  })

  test('USD display converts an ARS balance at the rate (ARS→USD divides)', () => {
    const result = convertHistoryPoint(point('2026-01', 1200, 5), 'USD', 1200)
    // 5 USD + 1200 ARS ÷ 1200 = 6 USD.
    expect(result.value).toBe(6)
  })

  test('a cross-currency month with no usable rate degrades to null', () => {
    const result = convertHistoryPoint(point('2026-01', 1000, 10), 'ARS', null)
    expect(result.value).toBeNull()
  })

  test('a display-only month still renders without a rate', () => {
    // USD display, no ARS balance → nothing to convert even with a null rate.
    const result = convertHistoryPoint(point('2026-01', 0, 50), 'USD', null)
    expect(result.value).toBe(50)
  })
})

describe('convertNetWorthSeries + hasAnyConvertedValue', () => {
  const months = [point('2026-01', 1000, 0), point('2026-02', 2000, 10)]

  test('converts the series in order at a single rate', () => {
    const series = convertNetWorthSeries(months, 'ARS', 1000)
    expect(series.map((p) => p.value)).toEqual([1000, 12_000])
  })

  test('reports at least one convertible point', () => {
    const converted = convertNetWorthSeries(months, 'ARS', 1000)
    expect(hasAnyConvertedValue(converted)).toBe(true)
  })

  test('reports no convertible point when every cross-currency month lacks a rate', () => {
    const usdOnly = [point('2026-01', 500, 0), point('2026-02', 700, 5)]
    // USD display: the ARS balance in each month needs a rate; with none, both
    // degrade to null.
    const converted = convertNetWorthSeries(usdOnly, 'USD', null)
    expect(hasAnyConvertedValue(converted)).toBe(false)
  })
})
