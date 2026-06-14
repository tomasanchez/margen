/**
 * Unit tests for the transactions API client + DTO adapter (ADR-034, ADR-038).
 *
 * Asserts the contract adaptation in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, Decimal-string money is parsed
 * to numbers, the UUID `id` stays a string, and `occurredOn` is sent straight
 * from the form's date picker on create (ADR-041). DELETE (204) resolves to
 * void; non-2xx throws an error carrying the HTTP status so TanStack Query
 * treats it as a failure.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  TransactionApiError,
  adaptTransaction,
  toCreateBody,
  transactionsClient,
  type TransactionDto,
} from './transactionsClient'
import type { NewTransactionInput } from '../mock/types'

/** A complete backend DTO (camelCase, Decimal strings, UUID id). */
const usdDto: TransactionDto = {
  id: '11111111-2222-4333-8444-555566667777',
  occurredOn: '2026-06-12',
  dispDate: 'Jun 12',
  month: 'June',
  name: 'Invoice · Atlas Co.',
  notes: null,
  category: 'Income',
  bank: 'Transfer',
  currency: 'USD',
  type: 'income',
  kind: 'invoice',
  amountNum: '622500.00',
  usd: '500.00',
  rate: '1245.00',
  fxRateType: 'MEP',
  fxRateAsOf: '2026-06-12T00:00:00Z',
  recurring: false,
  countsTowardMonotributo: true,
  createdAt: '2026-06-12T10:00:00Z',
  updatedAt: '2026-06-12T10:00:00Z',
}

describe('adaptTransaction', () => {
  test('unwraps Decimal strings to numbers and keeps the UUID string id', () => {
    const t = adaptTransaction(usdDto)

    expect(t.id).toBe('11111111-2222-4333-8444-555566667777')
    expect(typeof t.id).toBe('string')
    expect(t.amountNum).toBe(622500)
    expect(typeof t.amountNum).toBe('number')
    expect(t.usd).toBe(500)
    expect(t.rate).toBe(1245)
    expect(t.currency).toBe('USD')
    expect(t.dispDate).toBe('Jun 12')
    expect(t.month).toBe('June')
    // occurredOn (ISO date) is carried so Home can filter by year+month (ADR-040).
    expect(t.occurredOn).toBe('2026-06-12')
  })

  test('omits usd/rate when the DTO carries null FX fields', () => {
    const arsDto: TransactionDto = {
      ...usdDto,
      currency: 'ARS',
      type: 'expense',
      kind: 'expense',
      amountNum: '38400.00',
      usd: null,
      rate: null,
    }
    const t = adaptTransaction(arsDto)

    expect(t.amountNum).toBe(38400)
    expect(t.usd).toBeUndefined()
    expect(t.rate).toBeUndefined()
    expect('recurring' in t).toBe(false)
  })
})

describe('toCreateBody', () => {
  test('sends the picker occurredOn straight through and maps the money fields', () => {
    const input: NewTransactionInput = {
      occurredOn: '2026-06-12',
      dispDate: 'Jun 12',
      name: 'Invoice · Atlas Co.',
      category: 'Income',
      bank: 'Transfer',
      currency: 'USD',
      type: 'income',
      kind: 'invoice',
      amountNum: 622500,
      usd: 500,
      rate: 1245,
      countsTowardMonotributo: true,
    }
    const body = toCreateBody(input)

    // The picker's real ISO date is sent verbatim (ADR-041) — no derivation.
    expect(body.occurredOn).toBe('2026-06-12')
    expect(body.kind).toBe('invoice')
    expect(body.amountNum).toBe(622500)
    expect(body.usd).toBe(500)
    expect(body.rate).toBe(1245)
    expect(body.countsTowardMonotributo).toBe(true)
    // `type` is never sent — the backend derives it from `kind` (ADR-027).
    expect('type' in body).toBe(false)
  })

  test('a backdated date is sent unchanged (backdating allowed)', () => {
    const input: NewTransactionInput = {
      occurredOn: '2025-11-03',
      dispDate: 'Nov 03',
      name: 'Old expense',
      category: 'Food',
      bank: 'Transfer',
      currency: 'ARS',
      type: 'expense',
      kind: 'expense',
      amountNum: 5000,
    }
    expect(toCreateBody(input).occurredOn).toBe('2025-11-03')
  })
})

describe('transactionsClient HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('list() unwraps the { data } envelope and adapts each row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [usdDto] }), { status: 200 }),
    )

    const rows = await transactionsClient.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].amountNum).toBe(622500)
    expect(rows[0].id).toBe(usdDto.id)
  })

  test('create() POSTs the derived body and adapts the persisted row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: usdDto }), { status: 201 }),
    )

    const created = await transactionsClient.create({
      occurredOn: '2026-06-12',
      dispDate: 'Jun 12',
      name: 'Invoice · Atlas Co.',
      category: 'Income',
      bank: 'Transfer',
      currency: 'USD',
      type: 'income',
      kind: 'invoice',
      amountNum: 622500,
      usd: 500,
      rate: 1245,
    })

    expect(created.id).toBe(usdDto.id)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(init?.method).toBe('POST')
    const sent = JSON.parse(init?.body as string)
    expect(sent.occurredOn).toBe('2026-06-12')
    expect(sent.amountNum).toBe(622500)
  })

  test('remove() resolves to void on a 204', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(transactionsClient.remove(usdDto.id)).resolves.toBeUndefined()
  })

  test('a non-2xx response throws an error carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    await expect(transactionsClient.list()).rejects.toBeInstanceOf(
      TransactionApiError,
    )
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(transactionsClient.remove(usdDto.id)).rejects.toMatchObject({
      status: 404,
    })
  })
})
