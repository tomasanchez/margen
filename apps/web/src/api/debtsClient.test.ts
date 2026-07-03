/**
 * Unit tests for the debts API client + DTO adapter/body builders (ADR-187, ADR-183).
 *
 * Asserts the contract boundary in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, the enum-ish `currency` is
 * narrowed, money stays a Decimal STRING end-to-end (ADR-025/034), list/create/
 * patch/delete hit the right verb + URL, and the create/patch bodies drop blank
 * optionals (never sending null, ADR-187). Any non-2xx throws a DebtApiError
 * carrying the HTTP status (ADR-037/130).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DebtApiError,
  adaptDebt,
  debtsClient,
  toDebtCreateBody,
  toDebtPatchBody,
  type DebtDto,
  type DebtFormInput,
} from './debtsClient'

/** A complete backend debt DTO (camelCase, Decimal-string money, UUID id). */
const debtDto: DebtDto = {
  id: '11111111-2222-4333-8444-555566667777',
  name: 'Banco Nación loan',
  currency: 'ARS',
  currentBalance: '500000.00',
  monthlyMinimum: '25000.00',
  rate: '85.5',
}

/** A form input with all fields populated. */
const fullInput: DebtFormInput = {
  name: 'Banco Nación loan',
  currency: 'ARS',
  currentBalance: '500000.00',
  monthlyMinimum: '25000.00',
  rate: '85.5',
}

describe('adaptDebt', () => {
  test('keeps id + name + Decimal-string money and narrows the currency', () => {
    const debt = adaptDebt(debtDto)
    expect(debt.id).toBe('11111111-2222-4333-8444-555566667777')
    expect(debt.name).toBe('Banco Nación loan')
    expect(debt.currency).toBe('ARS')
    expect(debt.currentBalance).toBe('500000.00')
    expect(typeof debt.currentBalance).toBe('string')
    expect(debt.monthlyMinimum).toBe('25000.00')
    expect(debt.rate).toBe('85.5')
  })

  test('narrows USD and falls back an unknown currency to ARS', () => {
    expect(adaptDebt({ ...debtDto, currency: 'USD' }).currency).toBe('USD')
    expect(adaptDebt({ ...debtDto, currency: 'EUR' }).currency).toBe('ARS')
  })

  test('carries null optionals through as null', () => {
    const debt = adaptDebt({ ...debtDto, monthlyMinimum: null, rate: null })
    expect(debt.monthlyMinimum).toBeNull()
    expect(debt.rate).toBeNull()
  })
})

describe('toDebtCreateBody', () => {
  test('sends name/currency/currentBalance + present optionals (trimmed)', () => {
    expect(toDebtCreateBody({ ...fullInput, name: '  Loan  ' })).toEqual({
      name: 'Loan',
      currency: 'ARS',
      currentBalance: '500000.00',
      monthlyMinimum: '25000.00',
      rate: '85.5',
    })
  })

  test('omits blank optionals rather than sending null (ADR-187)', () => {
    const body = toDebtCreateBody({
      ...fullInput,
      monthlyMinimum: '',
      rate: '   ',
    })
    expect(body).toEqual({
      name: 'Banco Nación loan',
      currency: 'ARS',
      currentBalance: '500000.00',
    })
    expect('monthlyMinimum' in body).toBe(false)
    expect('rate' in body).toBe(false)
  })
})

describe('toDebtPatchBody', () => {
  test('sends the always-present fields + present optionals', () => {
    expect(toDebtPatchBody({ ...fullInput, currency: 'USD' })).toEqual({
      name: 'Banco Nación loan',
      currency: 'USD',
      currentBalance: '500000.00',
      monthlyMinimum: '25000.00',
      rate: '85.5',
    })
  })

  test('omits blank optionals (an omitted field means unchanged, ADR-028/187)', () => {
    const body = toDebtPatchBody({ ...fullInput, monthlyMinimum: '', rate: '' })
    expect('monthlyMinimum' in body).toBe(false)
    expect('rate' in body).toBe(false)
  })
})

describe('debtsClient network', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('list GETs /debts and unwraps + adapts the envelope', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [debtDto] }), { status: 200 }),
    )
    const debts = await debtsClient.list()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/debts')
    expect(debts).toHaveLength(1)
    expect(debts[0].name).toBe('Banco Nación loan')
    expect(debts[0].currentBalance).toBe('500000.00')
  })

  test('create POSTs /debts with the built body and returns the adapted debt', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: debtDto }), { status: 201 }),
    )
    const debt = await debtsClient.create({
      ...fullInput,
      monthlyMinimum: '',
      rate: '',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/debts')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Banco Nación loan',
      currency: 'ARS',
      currentBalance: '500000.00',
    })
    expect(debt.id).toBe(debtDto.id)
  })

  test('update PATCHes /debts/{id} with the patch body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: debtDto }), { status: 200 }),
    )
    await debtsClient.update(debtDto.id, fullInput)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/debts/${debtDto.id}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Banco Nación loan',
      currency: 'ARS',
      currentBalance: '500000.00',
      monthlyMinimum: '25000.00',
      rate: '85.5',
    })
  })

  test('remove DELETEs /debts/{id} (204, no body)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await debtsClient.remove(debtDto.id)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/debts/${debtDto.id}`)
    expect(init?.method).toBe('DELETE')
  })

  test('throws a DebtApiError carrying the HTTP status on a non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(debtsClient.remove('missing')).rejects.toBeInstanceOf(
      DebtApiError,
    )
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('nope', { status: 422 }),
    )
    await expect(debtsClient.list()).rejects.toMatchObject({ status: 422 })
  })
})
