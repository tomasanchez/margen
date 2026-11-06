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
  AllocationExceedsTargetError,
  InstallmentAmountBelowPaidError,
  InstallmentScheduleLockedError,
  ReceivableItemIdConflictError,
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
  createdAt: '2026-08-01T12:00:00Z',
  outstanding: '15000.00',
  upcomingTotal: '0.00',
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
  dueOutstanding: '7500.00',
  upcomingTotal: '0.00',
  installments: [],
  sourceTransaction: null,
  linkedTotalExceedsExpense: false,
}

/** A full person detail. */
const personDetail: PersonDetail = {
  id: person.id,
  name: 'Ana',
  createdAt: '2026-08-01T12:00:00Z',
  outstanding: '7500.00',
  upcomingTotal: '0.00',
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

  test('appends full=true ONLY when the full-history mode is requested (ADR-212)', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    const pdfResponse = () =>
      new Response('%PDF-1.4', {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })

    // Default (outstanding-only): the language is sent but NO `full` param, so the
    // URL stays clean.
    vi.mocked(fetch).mockResolvedValueOnce(pdfResponse())
    await receivablesClient.downloadPersonPdf(person.id, 'Ana', 'es')
    const outstandingUrl = String(vi.mocked(fetch).mock.calls[0][0])
    expect(outstandingUrl).toContain('lang=es')
    expect(outstandingUrl).not.toContain('full')

    // Full-history opt-in: `full=true` is appended alongside the language, joined
    // with `&` so the query string stays valid.
    vi.mocked(fetch).mockResolvedValueOnce(pdfResponse())
    await receivablesClient.downloadPersonPdf(person.id, 'Ana', 'es', true)
    const fullUrl = String(vi.mocked(fetch).mock.calls[1][0])
    expect(fullUrl).toContain('lang=es')
    expect(fullUrl).toContain('&full=true')

    clickSpy.mockRestore()
  })
})

describe('pdfFilename', () => {
  test('slugs a name and falls back for an empty one', () => {
    expect(pdfFilename('Ana García')).toBe('receivables-ana-garcia.pdf')
    expect(pdfFilename('   ')).toBe('receivables-person.pdf')
  })
})

describe('installments + expense link endpoints (ADR-214…221)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  const ok = () =>
    new Response(JSON.stringify({ data: personDetail }), { status: 200 })

  test('addItem sends the cuota plan + link, and omits them when unset', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    await receivablesClient.addItem(person.id, {
      occurredOn: '2026-08-01',
      amount: '300000.00',
      detail: 'Flights',
      installments: { count: 3, firstDueOn: '2026-09-01' },
      sourceTransactionId: 'tx-1',
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      occurredOn: '2026-08-01',
      amount: '300000.00',
      detail: 'Flights',
      installments: { count: 3, firstDueOn: '2026-09-01' },
      sourceTransactionId: 'tx-1',
    })

    await receivablesClient.addItem(person.id, {
      occurredOn: '2026-08-01',
      amount: '5000.00',
      installments: null,
      sourceTransactionId: null,
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      occurredOn: '2026-08-01',
      amount: '5000.00',
    })
  })

  test('editItem keeps the tri-state: omitted keeps, null removes / unlinks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    await receivablesClient.editItem(person.id, item.id, {
      installments: null,
      sourceTransactionId: null,
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      installments: null,
      sourceTransactionId: null,
    })

    await receivablesClient.editItem(person.id, item.id, { occurredOn: '2026-08-02' })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))
    expect(body).toEqual({ occurredOn: '2026-08-02' })
    expect('installments' in body).toBe(false)
    expect('sourceTransactionId' in body).toBe(false)
  })

  test('editInstallment PATCHes one cuota by index with only the given fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok())
    await receivablesClient.editInstallment(person.id, item.id, 3, {
      amount: '120000.00',
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(
      `/api/v1/receivables/people/${person.id}/items/${item.id}/installments/3`,
    )
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ amount: '120000.00' })
  })

  test('pardonInstallment / unpardonInstallment POST to the cuota toggles', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    await receivablesClient.pardonInstallment(person.id, item.id, 2)
    await receivablesClient.unpardonInstallment(person.id, item.id, 2)
    const [pardonUrl, pardonInit] = vi.mocked(fetch).mock.calls[0]
    const [unpardonUrl] = vi.mocked(fetch).mock.calls[1]
    expect(String(pardonUrl)).toContain(`/items/${item.id}/installments/2/pardon`)
    expect(pardonInit?.method).toBe('POST')
    expect(String(unpardonUrl)).toContain(
      `/items/${item.id}/installments/2/unpardon`,
    )
  })

  test('suggestedAllocation GETs the default spread for an amount', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            asOf: '2026-08-20',
            amount: '7500.00',
            allocated: '7500.00',
            unallocated: '0.00',
            allocations: [{ itemId: item.id, installmentId: null, amount: '7500.00' }],
          },
        }),
        { status: 200 },
      ),
    )
    const suggestion = await receivablesClient.suggestedAllocation(person.id, '7500.00')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      `/api/v1/receivables/people/${person.id}/suggested-allocation?amount=7500.00`,
    )
    expect(suggestion.allocations[0].amount).toBe('7500.00')
  })

  test('searchExpenseCandidates sends only the non-blank query params', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    await receivablesClient.searchExpenseCandidates({
      q: '  dinner ',
      from: '2026-10-01',
      to: '2026-10-31',
      limit: 20,
    })
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]), 'http://x')
    expect(url.pathname).toContain('/api/v1/receivables/expense-candidates')
    expect(url.searchParams.get('q')).toBe('dinner')
    expect(url.searchParams.get('from')).toBe('2026-10-01')
    expect(url.searchParams.get('to')).toBe('2026-10-31')
    expect(url.searchParams.get('limit')).toBe('20')

    await receivablesClient.searchExpenseCandidates({ q: '   ' })
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toMatch(
      /\/receivables\/expense-candidates$/,
    )
  })

  test('recordPayment passes each cuota allocation installmentId through', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok())
    await receivablesClient.recordPayment(person.id, {
      occurredOn: '2026-08-20',
      amount: '150.00',
      allocations: [
        { itemId: 'plan', installmentId: 'c1', amount: '100.00' },
        { itemId: item.id, amount: '50.00' },
      ],
    })
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).allocations,
    ).toEqual([
      { itemId: 'plan', installmentId: 'c1', amount: '100.00' },
      { itemId: item.id, amount: '50.00' },
    ])
  })

  test('a 409 installment_schedule_locked becomes a typed InstallmentScheduleLockedError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            code: 'installment_schedule_locked',
            itemId: item.id,
            reason: 'pardons',
          },
        }),
        { status: 409 },
      ),
    )
    const error = await receivablesClient
      .editItem(person.id, item.id, {
        installments: { count: 4, firstDueOn: '2026-09-01' },
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InstallmentScheduleLockedError)
    const locked = error as InstallmentScheduleLockedError
    expect(locked.status).toBe(409)
    expect(locked.reason).toBe('pardons')
    expect(locked.itemId).toBe(item.id)
    // Still a ReceivablesApiError (and not mistaken for an overpayment).
    expect(locked).toBeInstanceOf(ReceivablesApiError)
    expect(locked).not.toBeInstanceOf(ReceivableOverpaymentError)
  })
})

describe('idempotent create + review contract (ADR-204/206/216)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  /** A JSON error response with a machine-readable `detail`. */
  const typedError = (status: number, detail: unknown) =>
    new Response(JSON.stringify({ detail }), { status })

  test('addItem sends the idempotency id + cuota tweaks and returns createdItemId', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ...personDetail, createdItemId: 'item-9' } }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ...personDetail, createdItemId: 'item-10' } }),
          { status: 201 },
        ),
      )
    const created = await receivablesClient.addItem(person.id, {
      id: 'b6f1d6a0-5d2e-4f4b-9d0e-0a4b8c2d1e3f',
      occurredOn: '2026-08-01',
      amount: '1000.00',
      installments: {
        count: 3,
        firstDueOn: '2026-09-01',
        cuotas: [{ index: 3, amount: '400.00' }],
      },
    })
    expect(created.createdItemId).toBe('item-9')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      id: 'b6f1d6a0-5d2e-4f4b-9d0e-0a4b8c2d1e3f',
      occurredOn: '2026-08-01',
      amount: '1000.00',
      installments: {
        count: 3,
        firstDueOn: '2026-09-01',
        cuotas: [{ index: 3, amount: '400.00' }],
      },
    })

    // No tweaks → no empty `cuotas` array on the wire.
    await receivablesClient.addItem(person.id, {
      occurredOn: '2026-08-01',
      amount: '1000.00',
      installments: { count: 3, firstDueOn: '2026-09-01', cuotas: [] },
    })
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).installments,
    ).toEqual({ count: 3, firstDueOn: '2026-09-01' })
  })

  test('409 item_id_conflict → ReceivableItemIdConflictError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      typedError(409, { code: 'item_id_conflict', itemId: 'item-9' }),
    )
    const error = await receivablesClient
      .addItem(person.id, { id: 'item-9', occurredOn: '2026-08-01', amount: '1.00' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReceivableItemIdConflictError)
    expect((error as ReceivableItemIdConflictError).itemId).toBe('item-9')
    expect((error as ReceivableItemIdConflictError).status).toBe(409)
  })

  test('409 allocation_exceeds_target → AllocationExceedsTargetError (cuota or flat)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        typedError(409, {
          code: 'allocation_exceeds_target',
          itemId: 'plan',
          installmentId: 'c2',
          remaining: '100.00',
          requested: '150.00',
        }),
      )
      .mockResolvedValueOnce(
        typedError(409, {
          code: 'allocation_exceeds_target',
          itemId: item.id,
          installmentId: null,
          remaining: '7500.00',
          requested: '9000.00',
        }),
      )
    const payment = {
      occurredOn: '2026-08-20',
      amount: '150.00',
      allocations: [{ itemId: 'plan', installmentId: 'c2', amount: '150.00' }],
    }
    const cuota = await receivablesClient
      .recordPayment(person.id, payment)
      .catch((e: unknown) => e)
    expect(cuota).toBeInstanceOf(AllocationExceedsTargetError)
    expect(cuota).toMatchObject({
      itemId: 'plan',
      installmentId: 'c2',
      remaining: '100.00',
      requested: '150.00',
      status: 409,
    })
    // Not mistaken for the person-level overpayment.
    expect(cuota).not.toBeInstanceOf(ReceivableOverpaymentError)

    const flat = await receivablesClient
      .confirmMatch(person.id, {
        occurredOn: '2026-08-20',
        amount: '9000.00',
        matchedIncomeTransactionId: 'tx-1',
        allocations: [{ itemId: item.id, amount: '9000.00' }],
      })
      .catch((e: unknown) => e)
    expect(flat).toBeInstanceOf(AllocationExceedsTargetError)
    expect((flat as AllocationExceedsTargetError).installmentId).toBeNull()
  })

  test('422 installment_amount_below_paid → InstallmentAmountBelowPaidError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      typedError(422, {
        code: 'installment_amount_below_paid',
        itemId: 'plan',
        index: 2,
        paid: '40000.00',
        amount: '30000.00',
      }),
    )
    const error = await receivablesClient
      .editInstallment(person.id, 'plan', 2, { amount: '30000.00' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InstallmentAmountBelowPaidError)
    expect(error).toMatchObject({ index: 2, paid: '40000.00', status: 422 })
  })

  test('a validation 422 (a list of field errors) stays a plain status error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      typedError(422, [{ loc: ['body', 'occurredOn'], msg: 'out of range' }]),
    )
    const error = await receivablesClient
      .addItem(person.id, { occurredOn: '1999-01-01', amount: '1.00' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReceivablesApiError)
    expect(error).not.toBeInstanceOf(InstallmentAmountBelowPaidError)
    expect((error as ReceivablesApiError).status).toBe(422)
  })
})
