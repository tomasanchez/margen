/**
 * Unit tests for the redesigned `/reports` URL range plumbing (ADR-167).
 *
 * The analytics window lives in `?range=`: validate narrows a raw param to one of
 * the four presets (rejecting garbage + the stale `month` param),
 * `searchToReportRange` derives the live range (defaulting to 6M when absent),
 * and `rangeToReportsSearch` round-trips a range back, omitting the default 6M.
 */

import { describe, expect, test } from 'vitest'
import {
  DEFAULT_REPORTS_RANGE,
  isReportsRange,
  rangeToReportsSearch,
  searchToReportRange,
  validateReportsSearch,
} from './reportsSearch'

describe('isReportsRange', () => {
  test('accepts the four presets and rejects anything else', () => {
    expect(isReportsRange('3M')).toBe(true)
    expect(isReportsRange('6M')).toBe(true)
    expect(isReportsRange('12M')).toBe(true)
    expect(isReportsRange('YTD')).toBe(true)
    expect(isReportsRange('1M')).toBe(false)
    expect(isReportsRange('2026-03')).toBe(false)
    expect(isReportsRange(undefined)).toBe(false)
    expect(isReportsRange(6)).toBe(false)
  })
})

describe('validateReportsSearch', () => {
  test('keeps a valid range token', () => {
    expect(validateReportsSearch({ range: '12M' })).toEqual({ range: '12M' })
  })

  test('drops the stale month param and garbage', () => {
    expect(validateReportsSearch({ month: '2026-03' })).toEqual({})
    expect(validateReportsSearch({ range: 'nope' })).toEqual({})
    expect(validateReportsSearch({})).toEqual({})
  })
})

describe('searchToReportRange', () => {
  test('resolves a valid range', () => {
    expect(searchToReportRange({ range: '3M' })).toBe('3M')
  })

  test('falls back to the default 6M when absent or invalid', () => {
    expect(searchToReportRange({})).toBe(DEFAULT_REPORTS_RANGE)
    expect(searchToReportRange({ range: undefined })).toBe('6M')
  })
})

describe('rangeToReportsSearch', () => {
  test('omits the default 6M (short URL) and encodes any other range', () => {
    expect(rangeToReportsSearch('6M')).toEqual({})
    expect(rangeToReportsSearch('3M')).toEqual({ range: '3M' })
    expect(rangeToReportsSearch('YTD')).toEqual({ range: 'YTD' })
  })
})
