/**
 * Unit tests for the statement document fetcher (ADR-078, ADR-092).
 *
 * The statement document route is behind the Supabase bearer guard (ADR-092), so
 * the client fetches the stored PDF through `authedFetch` (a plain `<a href>` GET
 * would 401). These tests assert the URL builder and the authed blob fetch in
 * isolation, with `fetch` mocked (no real backend — ADR-038): a 2xx returns the
 * PDF Blob, a non-2xx throws a status-carrying {@link StatementsApiError}.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  StatementsApiError,
  fetchStatementDocument,
  parseStatement,
  statementDocumentUrl,
} from './statementsClient'

describe('statementDocumentUrl', () => {
  test('builds the versioned view/download path for a document id', () => {
    expect(statementDocumentUrl('doc-9')).toContain(
      '/api/v1/statements/doc-9/document',
    )
  })
})

describe('fetchStatementDocument', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('GETs the auth-gated document path and returns the PDF blob', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('%PDF-1.7', {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    )

    const blob = await fetchStatementDocument('doc-9')

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/statements/doc-9/document')
    expect(init?.method ?? 'GET').toBe('GET')
    // The bytes are returned as a Blob (cross-realm: assert by shape, not
    // `instanceof`, since undici's Blob differs from the test realm's).
    expect(typeof blob.arrayBuffer).toBe('function')
    expect(blob.type).toBe('application/pdf')
    expect(await blob.text()).toBe('%PDF-1.7')
  })

  test('a non-2xx response throws a StatementsApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(fetchStatementDocument('doc-9')).rejects.toBeInstanceOf(
      StatementsApiError,
    )

    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(fetchStatementDocument('doc-9')).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('parseStatement — adapts the bank/card identity (ADR-117)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A `status: 'ok'` parse DTO exposing the split bank/card identity (ADR-117). */
  function okParseEnvelope() {
    return {
      data: {
        status: 'ok',
        duplicate: false,
        bankName: 'Galicia',
        network: 'VISA',
        cardLast4: '5771',
        card: 'VISA ·5771',
        statementNumber: 'A-1000',
        issuerCuit: '20304050607',
        periodClose: '2026-05-20',
        periodDue: '2026-06-05',
        totalAmount: '128000.00',
        naturalKey: {
          issuerCuit: '20304050607',
          cardLast4: '5771',
          statementNumber: 'A-1000',
        },
        lines: [
          {
            occurredOn: '2026-06-19',
            purchaseDate: '2026-05-02',
            name: 'Carrefour',
            amount: '45000.00',
            currency: 'ARS',
            category: 'Food',
            lineKind: 'purchase',
            include: true,
          },
        ],
        document: {
          pdfBase64: 'ZmFrZQ==',
          contentType: 'application/pdf',
          bankName: 'Galicia',
          network: 'VISA',
          cardLast4: '5771',
        },
      },
    }
  }

  test('maps the normalized bankName + card detail and keeps network/cardLast4', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(okParseEnvelope()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const file = new File(['%PDF-1.7\n'], 'statement.pdf', {
      type: 'application/pdf',
    })
    const parse = await parseStatement(file)

    // The normalized bank (NOT a composite) and the card detail are surfaced
    // statement-level (ADR-117); network + last4 are preserved alongside.
    expect(parse.bankName).toBe('Galicia')
    expect(parse.card).toBe('VISA ·5771')
    expect(parse.network).toBe('VISA')
    expect(parse.cardLast4).toBe('5771')
    // The removed composite `paymentMethod` is gone from the adapted shape.
    expect(
      (parse as unknown as { paymentMethod?: string }).paymentMethod,
    ).toBeUndefined()
    // The line drafts still adapt (money parsed to a number).
    expect(parse.lines).toHaveLength(1)
    expect(parse.lines[0].name).toBe('Carrefour')
    expect(parse.lines[0].amount).toBe(45000)
  })
})
