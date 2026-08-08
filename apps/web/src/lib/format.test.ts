/**
 * Unit tests for the compact chart-axis money formatter (ADR-166).
 *
 * {@link formatCompactAxis} abbreviates a magnitude for a narrow Y-axis tick so
 * a full "USD 1.854,3" never wraps or clips; the tooltip + accessible summary
 * keep the full {@link formatCurrency}. We assert the `$` prefix, that large
 * magnitudes are abbreviated (much shorter than the grouped full form), that the
 * sign is dropped (axes render non-negative ticks), and — ICU-version-agnostic —
 * that the numeric body matches an es-AR compact reference for a spread of USD
 * and ARS magnitudes.
 */

import { describe, expect, test } from 'vitest'
import {
  MINUS,
  balanceAccessibleLabel,
  balanceColor,
  formatCompactAxis,
  formatSignedBalance,
} from './format'

/** The es-AR compact reference the helper is built on (ADR-102 domain locale). */
const ref = new Intl.NumberFormat('es-AR', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

describe('formatCompactAxis', () => {
  test('prefixes $ and matches the es-AR compact body across magnitudes', () => {
    // Spans the ARS millions/billions range and the USD hundreds/thousands range.
    for (const n of [500, 2_000, 1_854_300, 21_113_697, 9_500_000_000]) {
      expect(formatCompactAxis(n)).toBe(`$${ref.format(n)}`)
    }
  })

  test('abbreviates large magnitudes far shorter than the full grouped form', () => {
    // A full es-AR grouping of ~1.85M is "1.854.300" (9 chars); the compact tick
    // must be dramatically shorter so it fits a narrow axis without wrapping.
    const compact = formatCompactAxis(1_854_300)
    expect(compact.startsWith('$')).toBe(true)
    expect(compact.length).toBeLessThan('1.854.300'.length)
  })

  test('drops the sign — axis ticks render by magnitude', () => {
    expect(formatCompactAxis(-1_854_300)).toBe(formatCompactAxis(1_854_300))
  })

  test('handles a small USD magnitude without abbreviating it away', () => {
    // A USD-converted tick like 500 must still read as US$500, not US$0,5k.
    expect(formatCompactAxis(500, 'USD')).toBe(`US$${ref.format(500)}`)
  })

  test('uses US$ for USD and bare $ for ARS so an axis is never ambiguous', () => {
    expect(formatCompactAxis(1_854_300, 'USD')).toBe(`US$${ref.format(1_854_300)}`)
    expect(formatCompactAxis(1_854_300, 'ARS')).toBe(`$${ref.format(1_854_300)}`)
  })

  test('coerces nullish / non-finite input to $0', () => {
    expect(formatCompactAxis(null)).toBe(`$${ref.format(0)}`)
    expect(formatCompactAxis(undefined)).toBe(`$${ref.format(0)}`)
    expect(formatCompactAxis(Number.NaN)).toBe(`$${ref.format(0)}`)
  })
})

describe('formatSignedBalance', () => {
  test('signs a negative balance with the Unicode minus + currency prefix', () => {
    expect(formatSignedBalance(-48625.63, 'ARS')).toBe(`${MINUS}ARS 48.625,63`)
    expect(formatSignedBalance(-720, 'USD')).toBe(`${MINUS}USD 720`)
  })

  test('renders a positive balance by plain magnitude — no sign', () => {
    expect(formatSignedBalance(150000, 'ARS')).toBe('ARS 150.000')
    expect(formatSignedBalance(720, 'USD')).toBe('USD 720')
  })

  test('renders zero neutrally — no sign, not signed as negative', () => {
    expect(formatSignedBalance(0, 'ARS')).toBe('ARS 0')
    expect(formatSignedBalance(-0, 'ARS')).toBe('ARS 0')
  })

  test('coerces nullish / non-finite input to a plain zero', () => {
    expect(formatSignedBalance(null, 'ARS')).toBe('ARS 0')
    expect(formatSignedBalance(undefined, 'USD')).toBe('USD 0')
    expect(formatSignedBalance(Number.NaN, 'ARS')).toBe('ARS 0')
  })
})

describe('balanceColor', () => {
  test('maps a negative balance to the error token, else neutral text', () => {
    expect(balanceColor(-1)).toBe('error.main')
    expect(balanceColor(0)).toBe('text.primary')
    expect(balanceColor(150000)).toBe('text.primary')
    expect(balanceColor(null)).toBe('text.primary')
  })
})

describe('balanceAccessibleLabel', () => {
  test('spells out the negative sign word for a negative balance (en-pinned)', () => {
    // i18n is pinned to English in the test setup (ADR-105): sign.minus → "minus".
    expect(balanceAccessibleLabel(-48625.63, 'ARS')).toBe(
      'minus 48.625,63 Argentine pesos',
    )
    expect(balanceAccessibleLabel(-720, 'USD')).toBe('minus 720 US dollars')
  })

  test('omits a sign word for a zero/positive balance', () => {
    expect(balanceAccessibleLabel(150000, 'ARS')).toBe('150.000 Argentine pesos')
    expect(balanceAccessibleLabel(0, 'ARS')).toBe('0 Argentine pesos')
  })
})
