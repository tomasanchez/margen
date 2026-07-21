/**
 * Unit tests for the Monotributo derivations (ADR-046, ADR-049, ADR-052,
 * ADR-050).
 *
 * Pure functions, no DOM: `deriveComparison` (in the client) returns null with no
 * prior period and otherwise computes the signed used/percentUsed deltas plus the
 * category-changed / status-changed flags; `standingToState` adapts the real
 * standing to the legacy {@link MonotributoState} the Home card consumes
 * (preserving the status band → StatusPill level and the projection note);
 * `deriveProjection` reconstructs the projection figures from the standing + scale
 * and passes the projected category through.
 */

import { describe, expect, test } from 'vitest'
import { deriveComparison } from '../../api/monotributoClient'
import { deriveProjection, standingToState } from './derive'
import type {
  MonotributoScaleRow,
  MonotributoSnapshot,
  MonotributoStanding,
} from '../../mock/types'

/** A current standing: Category C, 60% used, projected to land in D. */
const current: MonotributoStanding = {
  category: 'C',
  activityType: 'services',
  annualLimit: 21_113_697,
  used: 12_713_696,
  remaining: 8_400_001,
  percentUsed: 60.2,
  ratio: 0.602,
  status: 'watch',
  projectedCategory: 'D',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2025-06-13',
  periodEnd: '2026-06-13',
  recommendation: null,
}

/** A prior standing: a lower category (B), lower % and a calmer status band. */
const previous: MonotributoStanding = {
  category: 'B',
  activityType: 'services',
  annualLimit: 15_058_448,
  used: 9_000_000,
  remaining: 6_058_448,
  percentUsed: 50,
  ratio: 0.5,
  status: 'safe',
  projectedCategory: 'C',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2024-06-13',
  periodEnd: '2025-06-13',
  recommendation: null,
}

const SCALE: MonotributoScaleRow[] = [
  { letter: 'B', annualCeiling: 15_058_448, cuotaServicios: 48_251, cuotaBienes: 48_251 },
  { letter: 'C', annualCeiling: 21_113_697, cuotaServicios: 56_502, cuotaBienes: 55_227 },
  { letter: 'D', annualCeiling: 26_212_853, cuotaServicios: 72_414, cuotaBienes: 70_661 },
]

function snapshot(
  previousStanding: MonotributoStanding | null,
): MonotributoSnapshot {
  return {
    current,
    previous: previousStanding,
    scale: SCALE,
    scaleEffectiveFrom: '2026-02-01',
    scaleNextReview: '2026-08-01',
    invoices: [],
  }
}

describe('deriveComparison', () => {
  test('returns null when there is no prior period', () => {
    expect(deriveComparison(snapshot(null))).toBeNull()
  })

  test('computes signed used + percentUsed deltas against the prior period', () => {
    const comparison = deriveComparison(snapshot(previous))
    expect(comparison).not.toBeNull()

    expect(comparison?.used).toEqual({
      current: 12_713_696,
      previous: 9_000_000,
      diff: 3_713_696,
    })
    expect(comparison?.percentUsed.current).toBeCloseTo(60.2, 5)
    expect(comparison?.percentUsed.previous).toBe(50)
    expect(comparison?.percentUsed.diff).toBeCloseTo(10.2, 5)
  })

  test('flags category and status as changed when they differ', () => {
    const comparison = deriveComparison(snapshot(previous))

    expect(comparison?.category).toEqual({
      current: 'C',
      previous: 'B',
      changed: true,
    })
    expect(comparison?.status).toEqual({
      current: 'watch',
      previous: 'safe',
      changed: true,
    })
  })

  test('flags category and status as unchanged when they match', () => {
    const samePrevious: MonotributoStanding = {
      ...previous,
      category: 'C',
      status: 'watch',
    }
    const comparison = deriveComparison(snapshot(samePrevious))

    expect(comparison?.category.changed).toBe(false)
    expect(comparison?.status.changed).toBe(false)
    // A drop in usage yields a negative signed diff.
    expect(comparison?.used.diff).toBe(current.used - samePrevious.used)
  })
})

describe('standingToState', () => {
  test('adapts the standing to the legacy MonotributoState, preserving the status band', () => {
    const state = standingToState(current)

    expect(state.category).toBe('C')
    expect(state.used).toBe(12_713_696)
    expect(state.annualLimit).toBe(21_113_697)
    expect(state.usedRatio).toBe(0.602)
    // `remaining` becomes the card's `margin`.
    expect(state.margin).toBe(8_400_001)
    expect(state.projectedCategory).toBe('D')
    // The API's own estimate note is passed straight through (ADR-046).
    expect(state.projectedPaceLabel).toBe('Estimate, assumes steady pace')
    // Status band drives the StatusPill level unchanged.
    expect(state.status).toBe('watch')
  })

  test('carries an over-limit band through unchanged', () => {
    const over: MonotributoStanding = {
      ...current,
      status: 'over',
      percentUsed: 104,
      ratio: 1.04,
    }
    expect(standingToState(over).status).toBe('over')
  })
})

describe('deriveProjection', () => {
  test('passes the projected category through and reads its scale ceiling', () => {
    const projection = deriveProjection(current, SCALE)

    expect(projection.landsInCategory).toBe('D')
    // The fee impact reads current (C) vs projected (D) cuotaServicios.
    expect(projection.currentCuota).toBe(56_502)
    expect(projection.projectedCuota).toBe(72_414)
    // Invoiced-to-date is the standing's used total.
    expect(projection.invoicedToDate).toBe(12_713_696)
    // The projected annual estimate is labeled as an approximation.
    expect(projection.projectedAnnualLabel).toMatch(/^≈ ARS/)
    // The current category passes through so the note can compare against the
    // landing category (and avoid a nonsensical "move to the same category").
    expect(projection.currentCategory).toBe('C')
    // The period label is derived from the standing dates, not hardcoded.
    expect(projection.periodLabel).toBe('Jun 2025 – Jun 2026')
  })

  test('lands in the current category when the pace stays put (e.g. lowest band)', () => {
    // A standing already in its projected category — there is no move; the
    // current and landing categories match so the note reassures instead.
    const steady: MonotributoStanding = { ...current, projectedCategory: 'C' }
    const projection = deriveProjection(steady, SCALE)

    expect(projection.currentCategory).toBe('C')
    expect(projection.landsInCategory).toBe('C')
    // No fee delta when the category is unchanged.
    expect(projection.projectedCuota).toBe(projection.currentCuota)
  })

  test('falls back to the standing limit when the projected row is missing', () => {
    // A scale without D forces the ceiling fallback path.
    const scaleNoD = SCALE.filter((r) => r.letter !== 'D')
    const projection = deriveProjection(current, scaleNoD)
    // Projected cuota falls back to the current cuota when the row is absent.
    expect(projection.projectedCuota).toBe(56_502)
  })
})
