/**
 * Unit tests for the receivables API client (ADR-204/206/208).
 *
 * Focus (per task 7): the contract boundary in isolation with `fetch` mocked —
 * the `{ data }` envelope is unwrapped, money stays a Decimal STRING (ADR-025),
 * the right verb + URL are hit, blank optionals are dropped, and — the key case —
 * the overpayment `409` body is parsed into a typed {@link ReceivableOverpaymentError}
 * carrying `outstanding` / `requested` while other non-2xx stay a status-carrying
 * {@link ReceivablesApiError}. Also covers the authed PDF-download helper
 * (fetch blob → object URL → click a hidden `<a download>` → revoke). Fuller
 * feature coverage is task 10.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ReceivableOverpaymentError,
  ReceivablesApiError,
  pdfFilename,
  receivablesClient,
  type MatchSuggestion,
  type Person,
  type PersonDetail,
  type ReceivableItem,
} from './receivablesClient'

/** A person list row (camelCase, Decimal-string outstanding). */
const person: Person = {
  id: '11111111-2222-4333-8444-555566667777',
  name: 'Ana',
  outstanding: '15000.00',
}

/** One itemized debt with allocated / remaining (all Decimal strings). */
const item: ReceivableItem = {
  id: 'aaaa1111-2222-4333-8444-555566667777',
  occurredOn: '2026-08-01',
  amount: '10000.00',
  detail: 'Dinner split',
  allocated: '2500.00',
  remaining: '7500.00',
  pardoned: false,
}

/** A full person detail. */
const personDetail: PersonDetail = {
  id: person.id,
  name: 'Ana',
  outstanding: '7500.00',
  items: [item],
}

describe('receivablesClient reads', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('listPeople GETs /receivables/people and unwraps the envelope (money stays a string)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [person] }), { status: 200 }),
    )
    const people = await receivablesClient.listPeople()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/receivables/people')
    expect(people).toHaveLength(1)
    expect(people[0].outstanding).toBe('15000.00')
    expect(typeof people[0].outstanding).toBe('string')
  })

  test('getPerson GETs /receivables/people/{id} and returns items with remainders', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: personDetail }), { status: 200 }),
    )
    const detail = await receivablesClient.getPerson(person.id)
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/receivables/people/${person.id}`)
    expect(detail.items[0].remaining).toBe('7500.00')
  })

  test('matchSuggestions GETs the ranked candidates', async () => {
    const suggestion: MatchSuggestion = {
      transactionId: 'tx-1',
      name: 'Transfer from Ana',
      amount: '7500.00',
      occurredOn: '2026-08-20',
      score: 0.92,
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [suggestion] }), { status: 200 }),
    )
    const suggestions = await receivablesClient.matchSuggestions(person.id)
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/match-suggestions`,
    )
    expect(suggestions[0].score).toBe(0.92)
  })
})

describe('receivablesClient writes', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('createPerson POSTs a trimmed name and returns the detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: personDetail }), { status: 201 }),
    )
    const created = await receivablesClient.createPerson('  Ana  ')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/receivables/people')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Ana' })
    expect(created.id).toBe(person.id)
  })

  test('addItem drops a blank detail and POSTs to /items', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: item }), { status: 201 }),
    )
    await receivablesClient.addItem(person.id, {
      occurredOn: '2026-08-01',
      amount: '10000.00',
      detail: '   ',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/receivables/people/${person.id}/items`)
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ occurredOn: '2026-08-01', amount: '10000.00' })
    expect('detail' in body).toBe(false)
  })

  test('recordPayment omits allowOverpayment when not requested', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'p1' } }), { status: 201 }),
    )
    await receivablesClient.recordPayment(person.id, {
      occurredOn: '2026-08-20',
      amount: '7500.00',
      allocations: [{ itemId: item.id, amount: '7500.00' }],
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/payments`,
    )
    const body = JSON.parse(String(init?.body))
    expect(body.source).toBe('manual')
    expect('allowOverpayment' in body).toBe(false)
  })

  test('recordPayment sends allowOverpayment: true on the retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'p1' } }), { status: 201 }),
    )
    await receivablesClient.recordPayment(person.id, {
      occurredOn: '2026-08-20',
      amount: '99999.00',
      allocations: [{ itemId: item.id, amount: '99999.00' }],
      allowOverpayment: true,
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).allowOverpayment).toBe(true)
  })

  test('confirmMatch POSTs the FULL required body (occurredOn + amount + tx id + allocations)', async () => {
    // Guard against the contract drift that shipped a 422 on every confirm-match:
    // the API's ConfirmMatchRequest REQUIRES occurredOn (date) and amount
    // (Decimal string) alongside the matched id + allocations. Assert the actual
    // serialized body — the mock-the-boundary tests missed this exact mismatch.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'p1' } }), { status: 201 }),
    )
    await receivablesClient.confirmMatch(person.id, {
      occurredOn: '2026-08-20',
      amount: '7500.00',
      matchedIncomeTransactionId: 'tx-1',
      allocations: [{ itemId: item.id, amount: '7500.00' }],
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/confirm-match`,
    )
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      occurredOn: '2026-08-20',
      amount: '7500.00',
      matchedIncomeTransactionId: 'tx-1',
      allocations: [{ itemId: item.id, amount: '7500.00' }],
    })
    // Money stays a Decimal STRING end-to-end (ADR-025).
    expect(typeof body.amount).toBe('string')
  })

  test('pardonItem POSTs to /items/{id}/pardon and returns the refreshed detail', async () => {
    // The API returns the person with the item now flagged pardoned + a lower
    // outstanding (it no longer counts as owed, ADR-210).
    const pardonedDetail: PersonDetail = {
      ...personDetail,
      outstanding: '0.00',
      items: [{ ...item, pardoned: true }],
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: pardonedDetail }), { status: 200 }),
    )
    const detail = await receivablesClient.pardonItem(person.id, item.id)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/items/${item.id}/pardon`,
    )
    expect(init?.method).toBe('POST')
    expect(detail.items[0].pardoned).toBe(true)
    expect(detail.outstanding).toBe('0.00')
  })

  test('unpardonItem POSTs to /items/{id}/unpardon and restores the item', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: personDetail }), { status: 200 }),
    )
    const detail = await receivablesClient.unpardonItem(person.id, item.id)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/items/${item.id}/unpardon`,
    )
    expect(init?.method).toBe('POST')
    expect(detail.items[0].pardoned).toBe(false)
  })

  test('pardonItem surfaces a 404 as a status-carrying ReceivablesApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(
      receivablesClient.pardonItem(person.id, 'missing'),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('deletePerson DELETEs /people/{id} (204, no body)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await receivablesClient.deletePerson(person.id)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`/api/v1/receivables/people/${person.id}`)
    expect(init?.method).toBe('DELETE')
  })
})

describe('overpayment 409 → typed error (ADR-206)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('parses the receivable_overpayment body into a typed error with outstanding/requested', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            code: 'receivable_overpayment',
            outstanding: '7500.00',
            requested: '10000.00',
          },
        }),
        { status: 409 },
      ),
    )
    const promise = receivablesClient.recordPayment(person.id, {
      occurredOn: '2026-08-20',
      amount: '10000.00',
      allocations: [{ itemId: item.id, amount: '10000.00' }],
    })
    await expect(promise).rejects.toBeInstanceOf(ReceivableOverpaymentError)
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReceivableOverpaymentError)
    const overpayment = error as ReceivableOverpaymentError
    expect(overpayment.status).toBe(409)
    expect(overpayment.outstanding).toBe('7500.00')
    expect(overpayment.requested).toBe('10000.00')
    // It's still a ReceivablesApiError so generic catch paths keep working.
    expect(overpayment).toBeInstanceOf(ReceivablesApiError)
  })

  test('confirmMatch also surfaces the typed overpayment error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            code: 'receivable_overpayment',
            outstanding: '100.00',
            requested: '250.00',
          },
        }),
        { status: 409 },
      ),
    )
    await expect(
      receivablesClient.confirmMatch(person.id, {
        occurredOn: '2026-08-20',
        amount: '250.00',
        matchedIncomeTransactionId: 'tx-1',
        allocations: [{ itemId: item.id, amount: '250.00' }],
      }),
    ).rejects.toBeInstanceOf(ReceivableOverpaymentError)
  })

  test('a 409 that is NOT the overpayment shape stays a plain ReceivablesApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'some other conflict' }), {
        status: 409,
      }),
    )
    const error = await receivablesClient
      .recordPayment(person.id, {
        occurredOn: '2026-08-20',
        amount: '1.00',
        allocations: [],
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReceivablesApiError)
    expect(error).not.toBeInstanceOf(ReceivableOverpaymentError)
    expect((error as ReceivablesApiError).status).toBe(409)
  })

  test('a hard 422 over-allocation is a status-carrying ReceivablesApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('allocation exceeds payment', { status: 422 }),
    )
    await expect(
      receivablesClient.recordPayment(person.id, {
        occurredOn: '2026-08-20',
        amount: '100.00',
        allocations: [{ itemId: item.id, amount: '250.00' }],
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  test('a 404 becomes a status-carrying ReceivablesApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(
      receivablesClient.getPerson('missing'),
    ).rejects.toBeInstanceOf(ReceivablesApiError)
  })
})

describe('downloadPersonPdf helper', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  test('fetches the PDF, clicks a hidden <a download> with a slugged filename, then revokes', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('%PDF-1.4', {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    )

    await receivablesClient.downloadPersonPdf(person.id, 'Ana García')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/pdf`,
    )
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('receivables-ana-garcia.pdf')
    expect(anchor.getAttribute('href')).toBe('blob:mock-url')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    clickSpy.mockRestore()
  })

  test('throws (and never clicks) when the PDF fetch fails', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(
      receivablesClient.downloadPersonPdf(person.id, 'Ana'),
    ).rejects.toBeInstanceOf(ReceivablesApiError)
    expect(clickSpy).not.toHaveBeenCalled()
    clickSpy.mockRestore()
  })
})

describe('pdfFilename', () => {
  test('slugs a name and falls back for an empty one', () => {
    expect(pdfFilename('Ana García')).toBe('receivables-ana-garcia.pdf')
    expect(pdfFilename('   ')).toBe('receivables-person.pdf')
  })
})
