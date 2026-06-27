/**
 * Unit tests for the accounts API client + DTO adapter (ADR-122/123/130/133).
 *
 * Asserts the contract boundary in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, the enum-ish `type` / `currency`
 * are narrowed, money stays a Decimal STRING end-to-end (ADR-025/034), list/create
 * /update hit the right verb + URL, and net worth returns the total + per-account
 * breakdown (incl. the ADR-133 degrade where balanceConverted === balance). Any
 * non-2xx throws an AccountApiError carrying the HTTP status (ADR-037/130).
 *
 * Mirrors {@link settingsClient.test} / {@link transactionsClient.test}.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AccountApiError,
  accountsClient,
  adaptAccount,
  toWriteBody,
  type AccountDto,
  type NetWorth,
} from './accountsClient'
import type { NewAccountInput } from './accountsClient'

/** A complete backend account DTO (camelCase, Decimal-string money, UUID id). */
const bankDto: AccountDto = {
  id: '11111111-2222-4333-8444-555566667777',
  name: 'Galicia ARS',
  type: 'bank',
  currency: 'ARS',
  openingBalance: '150000.00',
}

describe('adaptAccount', () => {
  test('keeps the UUID id + Decimal-string balance and narrows the enums', () => {
    const account = adaptAccount(bankDto)
    expect(account.id).toBe('11111111-2222-4333-8444-555566667777')
    expect(account.name).toBe('Galicia ARS')
    expect(account.type).toBe('bank')
    expect(account.currency).toBe('ARS')
    // Money stays a Decimal STRING across the boundary (ADR-025/034).
    expect(account.openingBalance).toBe('150000.00')
    expect(typeof account.openingBalance).toBe('string')
  })

  test('narrows unknown type/currency to safe defaults', () => {
    const odd = adaptAccount({ ...bankDto, type: 'crypto', currency: 'EUR' })
    expect(odd.type).toBe('bank')
    expect(odd.currency).toBe('ARS')
  })

  test('carries a USD account currency through', () => {
    const usd = adaptAccount({ ...bankDto, type: 'cash', currency: 'USD' })
    expect(usd.type).toBe('cash')
    expect(usd.currency).toBe('USD')
  })
})

describe('toWriteBody', () => {
  test('forwards the four account fields verbatim (money kept as a string)', () => {
    const input: NewAccountInput = {
      name: 'Deel USD',
      type: 'bank',
      currency: 'USD',
      openingBalance: '1200.00',
    }
    expect(toWriteBody(input)).toEqual(input)
  })
})

describe('accountsClient.list', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /accounts, unwraps { data }, and adapts each row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [bankDto] }), { status: 200 }),
    )
    const accounts = await accountsClient.list()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/accounts')
    expect(init?.method).toBeUndefined()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe(bankDto.id)
  })

  test('a non-2xx response throws an AccountApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(accountsClient.list()).rejects.toBeInstanceOf(AccountApiError)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(accountsClient.list()).rejects.toMatchObject({ status: 404 })
  })
})

describe('accountsClient.create', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('POSTs the write body and returns the adapted account', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: bankDto }), { status: 201 }),
    )
    const created = await accountsClient.create({
      name: 'Galicia ARS',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/accounts')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Galicia ARS',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    expect(created.id).toBe(bankDto.id)
  })
})

describe('accountsClient.update', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('PUTs /accounts/{id} with the write body and returns the adapted account', async () => {
    const updated: AccountDto = { ...bankDto, name: 'Galicia pesos' }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: updated }), { status: 200 }),
    )
    const result = await accountsClient.update(bankDto.id, {
      name: 'Galicia pesos',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/accounts/${bankDto.id}`)
    expect(init?.method).toBe('PUT')
    expect(result.name).toBe('Galicia pesos')
  })
})

describe('accountsClient.netWorth', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /accounts/net-worth and returns the total + breakdown', async () => {
    const netWorth: NetWorth = {
      total: '1050000.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a1',
          name: 'Galicia ARS',
          currency: 'ARS',
          balance: '150000.00',
          balanceConverted: '150000.00',
        },
        {
          id: 'a2',
          name: 'Deel USD',
          currency: 'USD',
          balance: '720.00',
          balanceConverted: '900000.00',
        },
      ],
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: netWorth }), { status: 200 }),
    )
    const result = await accountsClient.netWorth()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/accounts/net-worth')
    expect(result.total).toBe('1050000.00')
    expect(result.currency).toBe('ARS')
    expect(result.accounts).toHaveLength(2)
    // The USD account's converted balance differs from its native balance.
    expect(result.accounts[1].balance).toBe('720.00')
    expect(result.accounts[1].balanceConverted).toBe('900000.00')
  })

  test('degrade case (ADR-133): balanceConverted equals native balance', async () => {
    const degraded: NetWorth = {
      total: '720.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a2',
          name: 'Deel USD',
          currency: 'USD',
          balance: '720.00',
          balanceConverted: '720.00',
        },
      ],
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: degraded }), { status: 200 }),
    )
    const result = await accountsClient.netWorth()
    expect(result.accounts[0].balanceConverted).toBe(
      result.accounts[0].balance,
    )
  })
})
