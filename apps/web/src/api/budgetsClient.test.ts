/**
 * Unit tests for the budgets API client + DTO adapters (ADR-125, ADR-037).
 *
 * Asserts the contract boundary in isolation with `fetch` mocked (no real
 * backend): the period read returns the `{ month, currency, categories }` object
 * DIRECTLY (no `{ data }` envelope), `target` / `remaining` stay nullable Decimal
 * STRINGS (ADR-025/034), the category is narrowed to the union, and PUT/DELETE
 * hit the right verb + URL + body (currency defaulting to ARS). Any non-2xx
 * throws a BudgetApiError carrying the HTTP status (ADR-037).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BudgetApiError,
  budgetsClient,
  adaptBudgetPeriod,
  type BudgetPeriodDto,
} from './budgetsClient'

/** A complete backend budgets period (no envelope), with one set + one unset target. */
const periodDto: BudgetPeriodDto = {
  month: '2026-06',
  currency: 'ARS',
  categories: [
    { category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' },
    { category: 'Transport', target: null, spent: '15000.00', remaining: null },
  ],
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

  test('GETs /budgets?month=YYYY-MM and reads the period directly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(periodDto), { status: 200 }),
    )
    const period = await budgetsClient.fetchBudgets('2026-06')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/budgets?month=2026-06')
    expect(init?.method).toBeUndefined()
    expect(period.month).toBe('2026-06')
    expect(period.categories[0].category).toBe('Food')
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
