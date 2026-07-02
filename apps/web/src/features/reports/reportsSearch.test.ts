/**
 * Unit tests for the `/reports` URL search plumbing (ADR-040, mirroring
 * budgetsSearch). Assert: a strict `YYYY-MM` validates; range sentinels and
 * garbage are dropped; an absent/invalid month resolves to the current month;
 * and the current month encodes to an empty search (short URL) while any other
 * month serializes to `YYYY-MM`.
 */

import { describe, expect, test } from 'vitest'
import {
  monthToReportsSearch,
  searchToReportMonth,
  validateReportsSearch,
} from './reportsSearch'

const NOW = new Date(2026, 5, 15) // 2026-06

describe('validateReportsSearch', () => {
  test('keeps a strict YYYY-MM token', () => {
    expect(validateReportsSearch({ month: '2026-03' })).toEqual({ month: '2026-03' })
  })

  test('drops range sentinels and garbage', () => {
    expect(validateReportsSearch({ month: 'all' })).toEqual({})
    expect(validateReportsSearch({ month: 'nope' })).toEqual({})
    expect(validateReportsSearch({})).toEqual({})
  })
})

describe('searchToReportMonth', () => {
  test('resolves a valid month', () => {
    expect(searchToReportMonth({ month: '2026-03' }, NOW)).toEqual({
      year: 2026,
      month: 2,
    })
  })

  test('falls back to the current month when absent or invalid', () => {
    expect(searchToReportMonth({}, NOW)).toEqual({ year: 2026, month: 5 })
    expect(searchToReportMonth({ month: 'bad' }, NOW)).toEqual({
      year: 2026,
      month: 5,
    })
  })
})

describe('monthToReportsSearch', () => {
  test('omits the current month (short URL) and encodes any other month', () => {
    expect(monthToReportsSearch({ year: 2026, month: 5 }, NOW)).toEqual({})
    expect(monthToReportsSearch({ year: 2026, month: 2 }, NOW)).toEqual({
      month: '2026-03',
    })
  })
})
