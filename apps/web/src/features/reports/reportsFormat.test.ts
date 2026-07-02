/**
 * Unit tests for the pure Reports presentation helpers (ADR-167): percent-change
 * with a null base, the good/bad chip decision (income up = good, expenses up =
 * bad), trend direction, and the SVG sparkline projection (flat, ascending, and
 * the too-short guard).
 */

import { describe, expect, test } from 'vitest'
import {
  deltaIsGood,
  pctChange,
  rangeMonths,
  sparklinePoints,
  trendDirection,
} from './reportsFormat'

describe('rangeMonths', () => {
  test('maps each preset to a month span', () => {
    expect(rangeMonths('3M')).toBe(3)
    expect(rangeMonths('6M')).toBe(6)
    expect(rangeMonths('12M')).toBe(12)
    expect(rangeMonths('YTD')).toBe(6)
  })
})

describe('pctChange', () => {
  test('computes a signed percent change', () => {
    expect(pctChange(120, 100)).toBe(20)
    expect(pctChange(80, 100)).toBe(-20)
  })

  test('returns null with no base (avoids a misleading ∞%)', () => {
    expect(pctChange(100, 0)).toBeNull()
    expect(pctChange(100, Number.NaN)).toBeNull()
  })

  test('handles a negative base by its magnitude', () => {
    // Net saved recovering from −100 to +50 is a positive move.
    expect(pctChange(50, -100)).toBeGreaterThan(0)
  })
})

describe('deltaIsGood', () => {
  test('income (higherIsBetter): a rise is good, a fall is not', () => {
    expect(deltaIsGood(20, true)).toBe(true)
    expect(deltaIsGood(-20, true)).toBe(false)
  })

  test('expenses (lowerIsBetter): a fall is good, a rise is not', () => {
    expect(deltaIsGood(-20, false)).toBe(true)
    expect(deltaIsGood(20, false)).toBe(false)
  })

  test('a null / flat delta reads as good (0% is never a warning)', () => {
    expect(deltaIsGood(null, true)).toBe(true)
    expect(deltaIsGood(0, false)).toBe(true)
  })
})

describe('trendDirection', () => {
  test('classifies up / down / flat from a fractional delta', () => {
    expect(trendDirection(0.06)).toBe('up')
    expect(trendDirection(-0.06)).toBe('down')
    expect(trendDirection(0)).toBe('flat')
    expect(trendDirection(null)).toBe('flat')
  })
})

describe('sparklinePoints', () => {
  test('projects an ascending series to rising points (Y inverted)', () => {
    const points = sparklinePoints([1, 2, 3], 100, 28).split(' ')
    expect(points).toHaveLength(3)
    // First point at x=0 sits at the bottom (max y), last at x=100 at the top.
    expect(points[0]).toBe('0.0,28.0')
    expect(points[2]).toBe('100.0,0.0')
  })

  test('draws a flat line at mid-height for a constant series', () => {
    const points = sparklinePoints([5, 5, 5], 100, 28).split(' ')
    // A constant series has range 1 (guarded) → every y is the full height.
    expect(points.every((p) => p.endsWith(',28.0'))).toBe(true)
  })

  test('returns empty for a series too short to draw a line', () => {
    expect(sparklinePoints([])).toBe('')
    expect(sparklinePoints([42])).toBe('')
  })
})
