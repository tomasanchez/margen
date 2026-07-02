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
import { formatCompactAxis } from './format'

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
