/**
 * Unit tests for the Monotributo API client + DTO adapter (ADR-046, ADR-049,
 * ADR-052, ADR-050).
 *
 * Asserts the contract adaptation in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, Decimal-string money/percent
 * is parsed to numbers, the field renames are resolved (`limit` → `annualLimit`,
 * `percentUsed` → `ratio` = pct ÷ 100, the invoice `occurredOn`/`name`/`category`/
 * `isForeignCurrency` → `dispDate`/`client`/`note`/`fx`), `previous` is null when
 * the API returns null, and a non-2xx response throws a status-carrying
 * {@link MonotributoApiError}.
 *
 * The category WRITE path moved to `PATCH /settings` (ADR-054/057); its tests
 * live with the settings client, not here — this client is read-only now.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  MonotributoApiError,
  adaptInvoice,
  adaptSnapshot,
  adaptStanding,
  fetchMonotributo,
  type MonotributoSnapshotDto,
  type MonotributoStandingDto,
} from './monotributoClient'

/** A complete backend standing DTO (camelCase, Decimal strings, four-band status). */
const currentDto: MonotributoStandingDto = {
  category: 'C',
  activityType: 'services',
  limit: '21113697.00',
  used: '12713696.50',
  remaining: '8400000.50',
  percentUsed: '60.23',
  status: 'watch',
  projectedCategory: 'D',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2025-06-13',
  periodEnd: '2026-06-13',
  recommendation: {
    typicalMonthlyExpenses: '850000.00',
    baselineMonths: 3,
    neededAnnualInvoicing: '10200000.00',
    category: 'B',
    monthlyFee: '48251.00',
    annualFee: '579012.00',
    effectiveTaxRatePct: '5.68',
    aboveScale: false,
  },
}

/** A prior-period standing DTO (a different category + lower usage). */
const previousDto: MonotributoStandingDto = {
  category: 'B',
  activityType: 'services',
  limit: '15058448.00',
  used: '9000000.00',
  remaining: '6058448.00',
  percentUsed: '59.77',
  status: 'safe',
  projectedCategory: 'C',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2024-06-13',
  periodEnd: '2025-06-13',
  recommendation: null,
}

/** A full snapshot DTO with one scale row and two invoices (one USD/FX). */
const snapshotDto: MonotributoSnapshotDto = {
  current: currentDto,
  previous: previousDto,
  scale: [
    {
      letter: 'C',
      annualCeiling: '21113697.00',
      cuotaServicios: '56502.00',
      cuotaBienes: '55227.00',
    },
  ],
  scaleEffectiveFrom: '2026-02-01',
  scaleNextReview: '2026-08-01',
  invoices: [
    {
      id: '11111111-2222-4333-8444-555566667777',
      occurredOn: '2026-01-22',
      name: 'Beta Studio',
      category: 'Income',
      amount: '4106196.00',
      currency: 'ARS',
      cumulative: '4106196.00',
      isForeignCurrency: false,
    },
    {
      id: '99999999-2222-4333-8444-555566667777',
      occurredOn: '2026-03-20',
      name: 'Atlas Co.',
      category: null,
      amount: '1770000.50',
      currency: 'USD',
      cumulative: '5876196.50',
      isForeignCurrency: true,
    },
  ],
}

describe('adaptStanding', () => {
  test('parses Decimal money to numbers and maps limit → annualLimit', () => {
    const standing = adaptStanding(currentDto)

    expect(standing.annualLimit).toBe(21_113_697)
    expect(typeof standing.annualLimit).toBe('number')
    expect(standing.used).toBe(12_713_696.5)
    expect(standing.remaining).toBe(8_400_000.5)
    expect(standing.category).toBe('C')
    expect(standing.status).toBe('watch')
    expect(standing.projectedCategory).toBe('D')
    expect(standing.projectionNote).toBe('Estimate, assumes steady pace')
    expect(standing.periodStart).toBe('2025-06-13')
    expect(standing.periodEnd).toBe('2026-06-13')
  })

  test('maps percentUsed → ratio = percentUsed / 100', () => {
    const standing = adaptStanding(currentDto)

    expect(standing.percentUsed).toBe(60.23)
    expect(standing.ratio).toBeCloseTo(0.6023, 5)
  })

  test('parses the best-category recommendation to numbers, keeping category + aboveScale (ADR-200)', () => {
    const { recommendation } = adaptStanding(currentDto)

    expect(recommendation).not.toBeNull()
    // typicalMonthlyExpenses is the trailing-3-month median (renamed from avgMonthlyExpenses).
    expect(recommendation?.typicalMonthlyExpenses).toBe(850_000)
    expect(recommendation?.baselineMonths).toBe(3)
    expect(recommendation?.neededAnnualInvoicing).toBe(10_200_000)
    expect(recommendation?.monthlyFee).toBe(48_251)
    expect(recommendation?.annualFee).toBe(579_012)
    expect(recommendation?.effectiveTaxRatePct).toBe(5.68)
    expect(typeof recommendation?.effectiveTaxRatePct).toBe('number')
    expect(recommendation?.category).toBe('B')
    expect(recommendation?.aboveScale).toBe(false)
  })

  test('carries baselineMonths through the adapter (median confidence, ADR-200)', () => {
    const { recommendation } = adaptStanding({
      ...currentDto,
      recommendation: {
        ...currentDto.recommendation!,
        baselineMonths: 1,
      },
    })
    expect(recommendation?.baselineMonths).toBe(1)
  })

  test('maps a null recommendation through as null', () => {
    const standing = adaptStanding(previousDto)
    expect(standing.recommendation).toBeNull()
  })
})

describe('adaptInvoice', () => {
  test('renames occurredOn → dispDate, name → client, category → note, isForeignCurrency → fx', () => {
    const invoice = adaptInvoice(snapshotDto.invoices[1], 1)

    // occurredOn (ISO) becomes a short "Mon DD" display label.
    expect(invoice.dispDate).toBe('Mar 20')
    expect(invoice.client).toBe('Atlas Co.')
    // A null category maps to an empty note (no crash).
    expect(invoice.note).toBe('')
    expect(invoice.amountNum).toBe(1_770_000.5)
    expect(invoice.cumulative).toBe(5_876_196.5)
    expect(invoice.fx).toBe(true)
    // The UUID contract id is dropped; the list id is the 1-based index.
    expect(invoice.id).toBe(2)
  })

  test('carries a present category through as the note', () => {
    const invoice = adaptInvoice(snapshotDto.invoices[0], 0)
    expect(invoice.note).toBe('Income')
    expect(invoice.fx).toBe(false)
    expect(invoice.id).toBe(1)
  })
})

describe('adaptSnapshot', () => {
  test('adapts current + scale + invoices and keeps previous when present', () => {
    const snapshot = adaptSnapshot(snapshotDto)

    expect(snapshot.current.category).toBe('C')
    expect(snapshot.previous).not.toBeNull()
    expect(snapshot.previous?.category).toBe('B')
    expect(snapshot.scale).toHaveLength(1)
    expect(snapshot.scale[0].annualCeiling).toBe(21_113_697)
    expect(snapshot.invoices).toHaveLength(2)
    expect(snapshot.invoices[0].client).toBe('Beta Studio')
  })

  test('carries the scale vintage dates through as ISO strings', () => {
    const snapshot = adaptSnapshot(snapshotDto)
    expect(snapshot.scaleEffectiveFrom).toBe('2026-02-01')
    expect(snapshot.scaleNextReview).toBe('2026-08-01')
  })

  test('returns previous=null when the API previous is null', () => {
    const snapshot = adaptSnapshot({ ...snapshotDto, previous: null })
    expect(snapshot.previous).toBeNull()
  })
})

describe('fetchMonotributo HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('GETs /monotributo, unwraps { data }, and returns the adapted snapshot', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: snapshotDto }), { status: 200 }),
    )

    const snapshot = await fetchMonotributo()

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/monotributo')
    // A bare GET (no method override).
    expect(init?.method).toBeUndefined()
    expect(snapshot.current.annualLimit).toBe(21_113_697)
    expect(snapshot.current.used).toBe(12_713_696.5)
    expect(snapshot.current.ratio).toBeCloseTo(0.6023, 5)
    expect(snapshot.invoices[1].fx).toBe(true)
  })

  test('a non-2xx response throws a MonotributoApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    await expect(fetchMonotributo()).rejects.toBeInstanceOf(MonotributoApiError)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    )
    await expect(fetchMonotributo()).rejects.toMatchObject({ status: 503 })
  })
})
