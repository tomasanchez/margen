/**
 * Unit tests for the institutions + accounts API client + DTO adapters
 * (ADR-122/123/130/133, restructured by ADR-134).
 *
 * Asserts the contract boundary in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, the enum-ish `type` / `currency`
 * are narrowed (incl. the new `wallet` type), money stays a Decimal STRING
 * end-to-end (ADR-025/034), institution + account list/create/update hit the
 * right verb + URL, and net worth returns the total + per-account breakdown (incl.
 * the ADR-133 degrade where balanceConverted === balance). Any non-2xx throws an
 * AccountApiError carrying the HTTP status (ADR-037/130).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AccountApiError,
  accountsClient,
  adaptAccount,
  adaptInstitution,
  toAccountWriteBody,
  toInstitutionWriteBody,
  type AccountDto,
  type InstitutionDto,
  type NetWorth,
} from './accountsClient'
import type { NewAccountInput } from './accountsClient'

/** A complete backend account DTO (camelCase, Decimal-string money, UUID id). */
const accountDto: AccountDto = {
  id: '11111111-2222-4333-8444-555566667777',
  institutionId: 'inst-1',
  institutionName: 'Galicia',
  type: 'bank',
  currency: 'ARS',
  openingBalance: '150000.00',
}

/** A complete backend institution DTO. */
const institutionDto: InstitutionDto = {
  id: 'inst-1',
  name: 'Galicia',
  type: 'bank',
}

describe('adaptInstitution', () => {
  test('keeps id + name and narrows the type', () => {
    const institution = adaptInstitution(institutionDto)
    expect(institution).toEqual({ id: 'inst-1', name: 'Galicia', type: 'bank' })
  })

  test('narrows the wallet type and falls back unknown types to bank', () => {
    expect(adaptInstitution({ ...institutionDto, type: 'wallet' }).type).toBe(
      'wallet',
    )
    expect(adaptInstitution({ ...institutionDto, type: 'crypto' }).type).toBe(
      'bank',
    )
  })
})

describe('adaptAccount', () => {
  test('keeps the UUID id + denormalized institution + Decimal-string balance', () => {
    const account = adaptAccount(accountDto)
    expect(account.id).toBe('11111111-2222-4333-8444-555566667777')
    expect(account.institutionId).toBe('inst-1')
    expect(account.institutionName).toBe('Galicia')
    expect(account.type).toBe('bank')
    expect(account.currency).toBe('ARS')
    // Money stays a Decimal STRING across the boundary (ADR-025/034).
    expect(account.openingBalance).toBe('150000.00')
    expect(typeof account.openingBalance).toBe('string')
  })

  test('narrows unknown type/currency to safe defaults', () => {
    const odd = adaptAccount({ ...accountDto, type: 'crypto', currency: 'EUR' })
    expect(odd.type).toBe('bank')
    expect(odd.currency).toBe('ARS')
  })

  test('carries a USD wallet account currency + type through', () => {
    const usd = adaptAccount({
      ...accountDto,
      institutionName: 'Deel',
      type: 'wallet',
      currency: 'USD',
    })
    expect(usd.type).toBe('wallet')
    expect(usd.currency).toBe('USD')
    expect(usd.institutionName).toBe('Deel')
  })
})

describe('write bodies', () => {
  test('toInstitutionWriteBody forwards name + type', () => {
    expect(toInstitutionWriteBody({ name: 'Deel', type: 'wallet' })).toEqual({
      name: 'Deel',
      type: 'wallet',
    })
  })

  test('toAccountWriteBody forwards institutionId + currency + balance', () => {
    const input: NewAccountInput = {
      institutionId: 'inst-2',
      currency: 'USD',
      openingBalance: '1200.00',
    }
    expect(toAccountWriteBody(input)).toEqual(input)
  })
})

describe('accountsClient institutions', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('listInstitutions GETs /institutions and adapts each row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [institutionDto] }), { status: 200 }),
    )
    const institutions = await accountsClient.listInstitutions()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/institutions')
    expect(init?.method).toBeUndefined()
    expect(institutions).toEqual([{ id: 'inst-1', name: 'Galicia', type: 'bank' }])
  })

  test('createInstitution POSTs the body and returns the adapted institution', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: institutionDto }), { status: 201 }),
    )
    const created = await accountsClient.createInstitution({
      name: 'Galicia',
      type: 'bank',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/institutions')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Galicia',
      type: 'bank',
    })
    expect(created.id).toBe('inst-1')
  })

  test('updateInstitution PUTs /institutions/{id}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ...institutionDto, name: 'Galicia BA' } }), {
        status: 200,
      }),
    )
    const result = await accountsClient.updateInstitution('inst-1', {
      name: 'Galicia BA',
      type: 'bank',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/institutions/inst-1')
    expect(init?.method).toBe('PUT')
    expect(result.name).toBe('Galicia BA')
  })
})

describe('accountsClient.list', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /accounts, unwraps { data }, and adapts each row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [accountDto] }), { status: 200 }),
    )
    const accounts = await accountsClient.list()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/accounts')
    expect(init?.method).toBeUndefined()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe(accountDto.id)
    expect(accounts[0].institutionName).toBe('Galicia')
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

  test('POSTs the write body (institutionId + currency + balance) and adapts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: accountDto }), { status: 201 }),
    )
    const created = await accountsClient.create({
      institutionId: 'inst-1',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/accounts')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      institutionId: 'inst-1',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    expect(created.id).toBe(accountDto.id)
  })
})

describe('accountsClient.update', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('PUTs /accounts/{id} with the write body and returns the adapted account', async () => {
    const updated: AccountDto = { ...accountDto, openingBalance: '200000.00' }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: updated }), { status: 200 }),
    )
    const result = await accountsClient.update(accountDto.id, {
      institutionId: 'inst-1',
      currency: 'ARS',
      openingBalance: '200000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/accounts/${accountDto.id}`)
    expect(init?.method).toBe('PUT')
    expect(result.openingBalance).toBe('200000.00')
  })
})

describe('accountsClient.netWorth', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /accounts/net-worth and returns the total + breakdown', async () => {
    const netWorth: NetWorth = {
      total: '1050000.00',
      currency: 'ARS',
      liabilities: {
        installments: '50000.00',
        installmentsNative: { ars: '50000.00', usd: '0' },
        ccBalance: null,
        other: null,
        total: '50000.00',
      },
      netAfterLiabilities: '1000000.00',
      accounts: [
        {
          id: 'a1',
          institutionId: 'inst-1',
          institutionName: 'Galicia',
          type: 'bank',
          currency: 'ARS',
          balance: '150000.00',
          balanceConverted: '150000.00',
        },
        {
          id: 'a2',
          institutionId: 'inst-2',
          institutionName: 'Deel',
          type: 'wallet',
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
    expect(result.accounts[1].institutionName).toBe('Deel')
    // The USD account's converted balance differs from its native balance.
    expect(result.accounts[1].balance).toBe('720.00')
    expect(result.accounts[1].balanceConverted).toBe('900000.00')
    // The layered liabilities reservation + derived net-after (ADR-180) pass
    // through as Decimal strings in the display currency (no re-conversion).
    expect(result.liabilities.installments).toBe('50000.00')
    expect(result.liabilities.total).toBe('50000.00')
    expect(result.liabilities.ccBalance).toBeNull()
    // The NATIVE installment breakdown (ADR-183 amendment) passes through so the
    // card can convert it at the live rate.
    expect(result.liabilities.installmentsNative).toEqual({
      ars: '50000.00',
      usd: '0',
    })
    expect(result.netAfterLiabilities).toBe('1000000.00')
  })

  test('defaults a missing liabilities tail to zero (pre-ADR-180 payload)', async () => {
    // A backend response WITHOUT the liabilities fields (e.g. an older deploy)
    // still adapts: liabilities collapse to 0 and netAfterLiabilities falls back
    // to the assets total, so the card shows the assets figure alone (ADR-180).
    const legacy = {
      total: '150000.00',
      currency: 'ARS',
      accounts: [],
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: legacy }), { status: 200 }),
    )
    const result = await accountsClient.netWorth()
    expect(result.liabilities).toEqual({
      installments: '0',
      installmentsNative: { ars: '0', usd: '0' },
      ccBalance: null,
      other: null,
      total: '0',
    })
    expect(result.netAfterLiabilities).toBe('150000.00')
  })

  test('degrade case (ADR-133): balanceConverted equals native balance', async () => {
    const degraded: NetWorth = {
      total: '720.00',
      currency: 'ARS',
      liabilities: {
        installments: '0',
        installmentsNative: { ars: '0', usd: '0' },
        ccBalance: null,
        other: null,
        total: '0',
      },
      netAfterLiabilities: '720.00',
      accounts: [
        {
          id: 'a2',
          institutionId: 'inst-2',
          institutionName: 'Deel',
          type: 'wallet',
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
