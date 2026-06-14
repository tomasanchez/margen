/**
 * Unit tests for the ARCA invoice API client + DTO adapter (ADR-070, ADR-072,
 * ADR-074).
 *
 * Asserts the contract adaptation in isolation, with `fetch` mocked (no real
 * backend — ADR-038): `parseInvoice` POSTs the PDF as multipart to
 * `/invoices/parse`, unwraps the `{ data }` envelope (ADR-030), parses
 * Decimal-string money to numbers (ADR-025/034), carries the snake_case parse
 * status + the advisory `duplicate` flag, and builds the create-time `document`
 * payload (client-read base64 + the parsed natural-key/record fields). A non-2xx
 * upload throws a status-carrying {@link InvoicesApiError} with the calm,
 * friendly copy for the documented 415/413/422 rejections. `fileToBase64`
 * strips the `data:` URI prefix; `documentUrl` builds the view/download path.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  InvoicesApiError,
  documentUrl,
  fileToBase64,
  parseInvoice,
} from './invoicesClient'

/** A PDF File whose bytes read back as the base64 of "%PDF-1.7\n". */
function pdfFile(name = 'invoice.pdf'): File {
  return new File(['%PDF-1.7\n'], name, { type: 'application/pdf' })
}

/** A full backend parse DTO (camelCase, Decimal money as strings, snake_case status). */
const okQrDto = {
  status: 'ok_qr' as const,
  duplicate: false,
  naturalKey: {
    emisorCuit: '20304050607',
    ptoVta: 3,
    tipoCmp: 11,
    nroCmp: 142,
  },
  occurredOn: '2026-05-20',
  name: 'Atlas Co.',
  kind: 'invoice',
  amount: '45000.00',
  currency: 'ARS',
  usdAmount: null,
  fxRate: null,
  fxRateType: null,
  fxRateAsOf: null,
  category: 'Income',
  countsTowardMonotributo: true,
}

describe('fileToBase64', () => {
  test('reads a File as base64 with the data: URI prefix stripped', async () => {
    const base64 = await fileToBase64(pdfFile())
    // The bare base64 of "%PDF-1.7\n" (no "data:application/pdf;base64," prefix).
    expect(base64).toBe(btoa('%PDF-1.7\n'))
    expect(base64).not.toContain('data:')
    expect(base64).not.toContain(',')
  })
})

describe('documentUrl', () => {
  test('builds the versioned view/download path for a transaction id', () => {
    expect(documentUrl('tx-abc-123')).toContain(
      '/api/v1/invoices/tx-abc-123/document',
    )
  })
})

describe('parseInvoice HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('POSTs the PDF as multipart to /invoices/parse', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: okQrDto }), { status: 200 }),
    )

    await parseInvoice(pdfFile())

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/invoices/parse')
    expect(init?.method).toBe('POST')
    // Multipart upload: the body is a FormData carrying the file field.
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    const uploaded = form.get('file')
    expect(uploaded).toBeInstanceOf(File)
    expect((uploaded as File).type).toBe('application/pdf')
  })

  test('unwraps { data } and parses Decimal money to numbers + carries the snake_case status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: okQrDto }), { status: 200 }),
    )

    const parse = await parseInvoice(pdfFile())

    expect(parse.status).toBe('ok_qr')
    expect(parse.duplicate).toBe(false)
    // Decimal string -> number.
    expect(parse.amount).toBe(45_000)
    expect(typeof parse.amount).toBe('number')
    expect(parse.currency).toBe('ARS')
    expect(parse.name).toBe('Atlas Co.')
    expect(parse.occurredOn).toBe('2026-05-20')
    expect(parse.countsTowardMonotributo).toBe(true)
    expect(parse.naturalKey).toEqual({
      emisorCuit: '20304050607',
      ptoVta: 3,
      tipoCmp: 11,
      nroCmp: 142,
    })
  })

  test('builds the create-time document: client base64 + natural-key string fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: okQrDto }), { status: 200 }),
    )

    const parse = await parseInvoice(pdfFile())

    // pdfBase64 comes from the client-read File, not echoed back by the parse.
    expect(parse.document.pdfBase64).toBe(btoa('%PDF-1.7\n'))
    expect(parse.document.contentType).toBe('application/pdf')
    // Natural-key ints are stringified for the backend `document` contract.
    expect(parse.document.emisorCuit).toBe('20304050607')
    expect(parse.document.ptoVta).toBe('3')
    expect(parse.document.tipoCmp).toBe('11')
    expect(parse.document.nroCmp).toBe('142')
    expect(parse.document.fecha).toBe('2026-05-20')
    expect(parse.document.importe).toBe(45_000)
    expect(parse.document.moneda).toBe('ARS')
  })

  test('maps a USD invoice with its FX block to numbers', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            ...okQrDto,
            status: 'ok_text_fallback',
            amount: '622500.00',
            currency: 'USD',
            usdAmount: '500.00',
            fxRate: '1245.00',
            fxRateType: 'MEP',
            fxRateAsOf: '2026-05-20T12:00:00.000Z',
          },
        }),
        { status: 200 },
      ),
    )

    const parse = await parseInvoice(pdfFile())

    expect(parse.status).toBe('ok_text_fallback')
    expect(parse.currency).toBe('USD')
    expect(parse.usdAmount).toBe(500)
    expect(parse.fxRate).toBe(1245)
    expect(parse.fxRateType).toBe('MEP')
    expect(parse.fxRateAsOf).toBe('2026-05-20T12:00:00.000Z')
    // ctz (the rate) flows into the document payload as a number.
    expect(parse.document.ctz).toBe(1245)
  })

  test('an unparseable result is a 200 (not an error) carrying status + the duplicate flag', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            status: 'unparseable',
            duplicate: true,
            naturalKey: null,
            occurredOn: null,
            name: null,
            kind: null,
            amount: null,
            currency: null,
            usdAmount: null,
            fxRate: null,
            fxRateType: null,
            fxRateAsOf: null,
            category: null,
            countsTowardMonotributo: null,
          },
        }),
        { status: 200 },
      ),
    )

    const parse = await parseInvoice(pdfFile())

    expect(parse.status).toBe('unparseable')
    expect(parse.duplicate).toBe(true)
    expect(parse.naturalKey).toBeNull()
    // No prefill fields on an unparseable PDF, but the base64 document still builds.
    expect('amount' in parse).toBe(false)
    expect(parse.document.pdfBase64).toBe(btoa('%PDF-1.7\n'))
  })

  test('carries the advisory duplicate flag from a parsed result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ...okQrDto, duplicate: true } }), {
        status: 200,
      }),
    )

    const parse = await parseInvoice(pdfFile())
    expect(parse.duplicate).toBe(true)
  })

  test('a non-2xx upload throws an InvoicesApiError carrying the HTTP status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(parseInvoice(pdfFile())).rejects.toBeInstanceOf(
      InvoicesApiError,
    )

    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(parseInvoice(pdfFile())).rejects.toMatchObject({ status: 500 })
  })

  test.each([
    [415, /not a PDF/i],
    [413, /too large/i],
    [422, /Couldn't read this as an ARCA invoice/i],
  ])(
    'a %i rejection carries a calm, friendly manual-fallback message',
    async (status, pattern) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status }))
      await expect(parseInvoice(pdfFile())).rejects.toMatchObject({
        status,
        message: expect.stringMatching(pattern),
      })
      // Every rejection message offers the manual fallback.
      await expect(
        (async () => {
          vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status }))
          await parseInvoice(pdfFile())
        })(),
      ).rejects.toMatchObject({ message: expect.stringMatching(/manually/i) })
    },
  )
})
