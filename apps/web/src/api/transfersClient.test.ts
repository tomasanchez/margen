/**
 * Unit tests for the Transfers API client + DTO adapters (ADR-135).
 *
 * Asserts the contract boundary in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped (ADR-030), money stays a Decimal
 * STRING end-to-end (ADR-025/034), list/create/delete hit the right verb + URL,
 * the create body forwards the fee lines, the response's `feeTransactionIds` are
 * surfaced, and any non-2xx throws a {@link TransferApiError} carrying the HTTP
 * status (ADR-037/130).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  TransferApiError,
  adaptTransfer,
  toTransferWriteBody,
  transfersClient,
  type TransferDto,
} from './transfersClient'
import type { NewTransferInput } from '../mock/types'

/** A complete backend transfer DTO (camelCase, Decimal-string money, UUID id). */
const transferDto: TransferDto = {
  id: '11111111-2222-4333-8444-555566667777',
  fromAccountId: 'acc-from',
  toAccountId: 'acc-to',
  amountOut: '1000.00',
  amountIn: '1000.00',
  occurredOn: '2026-06-20',
  note: 'savings top-up',
}

describe('adaptTransfer', () => {
  test('keeps ids + Decimal-string amounts + note', () => {
    const transfer = adaptTransfer(transferDto)
    expect(transfer.id).toBe('11111111-2222-4333-8444-555566667777')
    expect(transfer.fromAccountId).toBe('acc-from')
    expect(transfer.toAccountId).toBe('acc-to')
    expect(transfer.amountOut).toBe('1000.00')
    expect(transfer.amountIn).toBe('1000.00')
    expect(typeof transfer.amountOut).toBe('string')
    expect(transfer.occurredOn).toBe('2026-06-20')
    expect(transfer.note).toBe('savings top-up')
  })

  test('omits a null/empty note', () => {
    expect(adaptTransfer({ ...transferDto, note: null }).note).toBeUndefined()
    expect(adaptTransfer({ ...transferDto, note: undefined }).note).toBeUndefined()
  })
})

describe('toTransferWriteBody', () => {
  test('forwards the core fields and drops an empty note + empty fees', () => {
    const input: NewTransferInput = {
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '1000.00',
      occurredOn: '2026-06-20',
      note: '   ',
      fees: [],
    }
    expect(toTransferWriteBody(input)).toEqual({
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '1000.00',
      occurredOn: '2026-06-20',
    })
  })

  test('includes a trimmed note + the fee lines when present', () => {
    const input: NewTransferInput = {
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '950.00',
      occurredOn: '2026-06-20',
      note: '  wire  ',
      fees: [{ accountId: 'acc-from', amount: '15.00', label: 'Deel fee' }],
    }
    expect(toTransferWriteBody(input)).toEqual({
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '950.00',
      occurredOn: '2026-06-20',
      note: 'wire',
      fees: [{ accountId: 'acc-from', amount: '15.00', label: 'Deel fee' }],
    })
  })
})

describe('transfersClient', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('list GETs /transfers and adapts each row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [transferDto] }), { status: 200 }),
    )
    const transfers = await transfersClient.list()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/transfers')
    expect(init?.method).toBeUndefined()
    expect(transfers).toHaveLength(1)
    expect(transfers[0].id).toBe('11111111-2222-4333-8444-555566667777')
  })

  test('create POSTs the body (incl. fees) and returns the transfer + fee ids', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            ...transferDto,
            amountIn: '950.00',
            feeTransactionIds: ['fee-tx-1'],
          },
        }),
        { status: 201 },
      ),
    )
    const result = await transfersClient.create({
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '950.00',
      occurredOn: '2026-06-20',
      fees: [{ accountId: 'acc-from', amount: '15.00', label: 'Deel fee' }],
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/transfers')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '950.00',
      occurredOn: '2026-06-20',
      fees: [{ accountId: 'acc-from', amount: '15.00', label: 'Deel fee' }],
    })
    expect(result.transfer.amountIn).toBe('950.00')
    expect(result.feeTransactionIds).toEqual(['fee-tx-1'])
  })

  test('create defaults feeTransactionIds to [] when the field is absent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: transferDto }), { status: 201 }),
    )
    const result = await transfersClient.create({
      fromAccountId: 'acc-from',
      toAccountId: 'acc-to',
      amountOut: '1000.00',
      amountIn: '1000.00',
      occurredOn: '2026-06-20',
    })
    expect(result.feeTransactionIds).toEqual([])
  })

  test('remove DELETEs /transfers/{id}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await transfersClient.remove('transfer-9')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/transfers/transfer-9')
    expect(init?.method).toBe('DELETE')
  })

  test('throws a TransferApiError carrying the status on a non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    )
    await expect(transfersClient.list()).rejects.toMatchObject({
      name: 'TransferApiError',
      status: 403,
    })
    await expect(transfersClient.list()).rejects.toBeInstanceOf(TransferApiError)
  })
})
