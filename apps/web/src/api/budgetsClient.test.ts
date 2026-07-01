/**
 * Unit tests for the budgets API client + DTO adapters (ADR-125, ADR-037).
 *
 * Asserts the contract boundary in isolation with `fetch` mocked (no real
 * backend): every read is wrapped in the backend `{ data: T }` envelope (ADR-030)
 * and the client unwraps it, `target` / `remaining` stay nullable Decimal STRINGS
 * (ADR-025/034), the category is narrowed to the union, and PUT/DELETE hit the
 * right verb + URL + body (currency defaulting to ARS). Any non-2xx throws a
 * BudgetApiError carrying the HTTP status (ADR-037).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BudgetApiError,
  budgetsClient,
  adaptBudgetPeriod,
  type BudgetPeriodDto,
} from './budgetsClient'

/** A complete backend budgets period payload, with one set + one unset target. */
const periodDto: BudgetPeriodDto = {
  month: '2026-06',
  currency: 'ARS',
  categories: [
    { category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' },
    { category: 'Transport', target: null, spent: '15000.00', remaining: null },
  ],
}

/** Wrap a payload in the backend `{ data: T }` response envelope (ADR-030). */
function enveloped(payload: unknown): string {
  return JSON.stringify({ data: payload })
}

describe('adaptBudgetPeriod', () => {
  test('keeps month + currency and the nullable Decimal-string money', () => {
    const period = adaptBudgetPeriod(periodDto)
    expect(period.month).toBe('2026-06')
    expect(period.currency).toBe('ARS')
    expect(period.categories).toHaveLength(2)
    const [food, transport] = period.categories
    expect(food.category).toBe('Food')
    expect(food.target).toBe('120000.00')
    expect(typeof food.target).toBe('string')
    expect(food.remaining).toBe('30000.00')
    // An unset target stays null (not coerced to "0").
    expect(transport.target).toBeNull()
    expect(transport.remaining).toBeNull()
    expect(transport.spent).toBe('15000.00')
  })

  test('narrows an unknown currency to ARS', () => {
    expect(adaptBudgetPeriod({ ...periodDto, currency: 'EUR' }).currency).toBe(
      'ARS',
    )
  })
})

describe('budgetsClient.fetchBudgets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /budgets?month=YYYY-MM and unwraps the period from the envelope', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped(periodDto), { status: 200 }),
    )
    const period = await budgetsClient.fetchBudgets('2026-06')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets?month=2026-06')
    expect(String(url)).toContain('currency=ARS')
    expect(init?.method).toBeUndefined()
    expect(period.month).toBe('2026-06')
    expect(period.categories[0].category).toBe('Food')
  })

  test('threads the budget currency as the currency query param (ADR-152)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped({ ...periodDto, currency: 'USD' }), { status: 200 }),
    )
    const period = await budgetsClient.fetchBudgets('2026-06', 'USD')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('currency=USD')
    expect(period.currency).toBe('USD')
  })

  test('adapts the unconverted count, defaulting to 0 when absent (ADR-152)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped({ ...periodDto, unconverted: 5 }), { status: 200 }),
    )
    expect((await budgetsClient.fetchBudgets('2026-06', 'USD')).unconverted).toBe(5)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped(periodDto), { status: 200 }),
    )
    expect((await budgetsClient.fetchBudgets('2026-06')).unconverted).toBe(0)
  })

  test('a non-2xx response throws a BudgetApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(budgetsClient.fetchBudgets('2026-06')).rejects.toBeInstanceOf(
      BudgetApiError,
    )
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('nope', { status: 404 }),
    )
    await expect(budgetsClient.fetchBudgets('2026-06')).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('budgetsClient.setTarget', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('PUTs /budgets with the body and defaults the currency to ARS', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsClient.setTarget({
      category: 'Food',
      month: '2026-06',
      amount: '120000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      category: 'Food',
      month: '2026-06',
      amount: '120000.00',
      currency: 'ARS',
      // Existing target editing defaults to the spend kind (ADR-138).
      kind: 'spend',
    })
  })

  test('forwards an explicit currency unchanged', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsClient.setTarget({
      category: 'Food',
      month: '2026-06',
      amount: '50.00',
      currency: 'USD',
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).currency).toBe('USD')
  })

  test('a non-2xx PUT throws a BudgetApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('bad', { status: 422 }))
    await expect(
      budgetsClient.setTarget({
        category: 'Food',
        month: '2026-06',
        amount: '1',
      }),
    ).rejects.toMatchObject({ status: 422 })
  })
})

describe('budgetsClient.clearTarget', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('DELETEs /budgets?category=&month= with the category + month', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsClient.clearTarget('Food', '2026-06')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(init?.method).toBe('DELETE')
    expect(String(url)).toContain('category=Food')
    expect(String(url)).toContain('month=2026-06')
  })

  test('a non-2xx DELETE throws a BudgetApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('no', { status: 500 }))
    await expect(
      budgetsClient.clearTarget('Food', '2026-06'),
    ).rejects.toBeInstanceOf(BudgetApiError)
  })
})

describe('adaptBudgetPeriod (extended fields)', () => {
  test('parses savings[], floor, suggestedStrategy and pressure', () => {
    const period = adaptBudgetPeriod({
      ...periodDto,
      savings: [
        { bucket: 'EmergencyFund', percent: 7, amount: '35000.00' },
        { bucket: 'FxHedge', percent: 3, amount: '15000.00' },
      ],
      floor: { amount: '250000.00', source: 'computed' },
      suggestedStrategy: 'balanced',
      pressure: 'Stable',
    })
    expect(period.savings).toHaveLength(2)
    expect(period.savings[0]).toEqual({
      bucket: 'EmergencyFund',
      percent: 7,
      amount: '35000.00',
    })
    expect(period.floor).toEqual({ amount: '250000.00', source: 'computed' })
    expect(period.suggestedStrategy).toBe('balanced')
    expect(period.pressure).toBe('Stable')
  })

  test('defaults the extended fields when the backend omits them', () => {
    const period = adaptBudgetPeriod(periodDto)
    expect(period.savings).toEqual([])
    expect(period.floor).toBeNull()
    expect(period.suggestedStrategy).toBeNull()
    expect(period.pressure).toBeNull()
  })

  test('narrows an unknown strategy / pressure to null', () => {
    const period = adaptBudgetPeriod({
      ...periodDto,
      suggestedStrategy: 'reckless',
      pressure: 'Panicked',
    })
    expect(period.suggestedStrategy).toBeNull()
    expect(period.pressure).toBeNull()
  })

  test('carries the reimbursed reduction, defaulting to "0" when absent (ADR-158/160)', () => {
    const period = adaptBudgetPeriod({
      ...periodDto,
      categories: [
        // Positive reduction carried through as-is (already in the requested currency).
        { category: 'Social', target: '50000.00', spent: '30000.00', reimbursed: '12000.00', remaining: '20000.00' },
        // A legacy payload with no `reimbursed` field defaults to "0".
        { category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' },
      ],
    })
    expect(period.categories[0].reimbursed).toBe('12000.00')
    expect(period.categories[1].reimbursed).toBe('0')
  })
})

describe('adaptBudgetPeriod (isEssential grouping)', () => {
  test('stamps isEssential per category, defaulting a missing flag to false', () => {
    const period = adaptBudgetPeriod({
      ...periodDto,
      categories: [
        { category: 'Food', target: '1', spent: '0', remaining: '1', isEssential: true },
        { category: 'Shopping', target: '1', spent: '0', remaining: '1', isEssential: false },
        // No flag → defaults to false (Wants).
        { category: 'Other', target: null, spent: '0', remaining: null },
      ],
    })
    expect(period.categories[0].isEssential).toBe(true)
    expect(period.categories[1].isEssential).toBe(false)
    expect(period.categories[2].isEssential).toBe(false)
  })
})

describe('budgetsClient.fetchHistory', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /budgets/history?month= and unwraps + adapts the lines', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          categories: [
            { category: 'Food', avg3mo: '60000.00', lastMonth: '90000.00' },
            { category: 'Transport', avg3mo: '10000.00', lastMonth: '0' },
          ],
        }),
        { status: 200 },
      ),
    )
    const history = await budgetsClient.fetchHistory('2026-06', 'USD')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets/history?month=2026-06')
    // The budget currency denominates the history (ADR-152).
    expect(String(url)).toContain('currency=USD')
    expect(init?.method).toBeUndefined()
    expect(history).toEqual([
      { category: 'Food', avg3mo: '60000.00', lastMonth: '90000.00' },
      { category: 'Transport', avg3mo: '10000.00', lastMonth: '0' },
    ])
    // Money stays a Decimal string (ADR-025/034).
    expect(typeof history[0].avg3mo).toBe('string')
  })

  test('returns an empty list when the month has no history', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped({ categories: [] }), { status: 200 }),
    )
    expect(await budgetsClient.fetchHistory('2026-06')).toEqual([])
  })

  test('a non-2xx response throws a BudgetApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(budgetsClient.fetchHistory('2026-06')).rejects.toBeInstanceOf(
      BudgetApiError,
    )
  })
})

describe('budgetsClient.fetchBudgetIncome', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /budget-income?month= and adapts the payload', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          month: '2026-06',
          amount: '900000.00',
          currency: 'ARS',
          source: 'manual',
          floor: { amount: '300000.00', source: 'manual' },
        }),
        { status: 200 },
      ),
    )
    const income = await budgetsClient.fetchBudgetIncome('2026-06')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budget-income?month=2026-06')
    expect(income.amount).toBe('900000.00')
    expect(income.floor).toEqual({ amount: '300000.00', source: 'manual' })
  })

  test('keeps a null income amount null (unset)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          month: '2026-06',
          amount: null,
          currency: 'ARS',
          source: 'manual',
          floor: null,
        }),
        { status: 200 },
      ),
    )
    const income = await budgetsClient.fetchBudgetIncome('2026-06')
    expect(income.amount).toBeNull()
    expect(income.floor).toBeNull()
  })
})

describe('budgetsClient.setBudgetIncome', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('PUTs /budget-income with the amount and defaults currency to ARS', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsClient.setBudgetIncome({ month: '2026-06', amount: '900000.00' })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budget-income')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      month: '2026-06',
      amount: '900000.00',
      currency: 'ARS',
    })
  })

  test('includes the manual floor fields only when supplied', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsClient.setBudgetIncome({
      month: '2026-06',
      amount: '900000.00',
      floorAmount: '320000.00',
      floorSource: 'manual',
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      month: '2026-06',
      amount: '900000.00',
      currency: 'ARS',
      floorAmount: '320000.00',
      floorSource: 'manual',
    })
  })
})

describe('budgetsClient.fetchSuggestedBase', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /budget-income/suggested with the month + currency and returns the full suggestion', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          suggestedBase: '1200.00',
          monthsAvailable: 3,
          isSparse: true,
          currency: 'USD',
        }),
        { status: 200 },
      ),
    )
    const suggestion = await budgetsClient.fetchSuggestedBase('2026-06', 'USD')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budget-income/suggested?month=2026-06')
    expect(String(url)).toContain('currency=USD')
    expect(suggestion).toEqual({
      suggestedBase: '1200.00',
      monthsAvailable: 3,
      isSparse: true,
      currency: 'USD',
    })
  })

  test('returns a null base (with zero months) when there is no inflow history', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          suggestedBase: null,
          monthsAvailable: 0,
          isSparse: false,
          currency: 'ARS',
        }),
        { status: 200 },
      ),
    )
    const suggestion = await budgetsClient.fetchSuggestedBase('2026-06')
    expect(suggestion.suggestedBase).toBeNull()
    expect(suggestion.monthsAvailable).toBe(0)
  })
})

describe('budgetsClient.applyProfile', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('POSTs /budgets/apply-profile and returns the refreshed period + floor guard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        enveloped({
          ...periodDto,
          savings: [{ bucket: 'EmergencyFund', percent: 8, amount: '72000.00' }],
          floor: { amount: '250000.00', source: 'manual' },
          floorBreached: true,
          gap: '40000.00',
        }),
        { status: 200 },
      ),
    )
    const result = await budgetsClient.applyProfile('2026-06', 'aggressive')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets/apply-profile')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      month: '2026-06',
      profile: 'aggressive',
    })
    expect(result.period.savings).toHaveLength(1)
    expect(result.floorBreached).toBe(true)
    expect(result.gap).toBe('40000.00')
  })

  test('defaults floorBreached false / gap null when absent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped({ ...periodDto, savings: [] }), { status: 200 }),
    )
    const result = await budgetsClient.applyProfile('2026-06', 'balanced')
    expect(result.floorBreached).toBe(false)
    expect(result.gap).toBeNull()
  })
})

describe('budgetsClient.reprice', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('POSTs /budgets/reprice with from/to/inflation and omits empty stepUps', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped(periodDto), { status: 200 }),
    )
    await budgetsClient.reprice({
      fromMonth: '2026-05',
      toMonth: '2026-06',
      monthlyInflation: 2,
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets/reprice')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      fromMonth: '2026-05',
      toMonth: '2026-06',
      monthlyInflation: 2,
    })
  })

  test('forwards per-category stepUps when present', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(enveloped(periodDto), { status: 200 }),
    )
    await budgetsClient.reprice({
      fromMonth: '2026-05',
      toMonth: '2026-06',
      monthlyInflation: 2,
      stepUps: { Housing: '50000.00' },
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).stepUps).toEqual({ Housing: '50000.00' })
  })
})
