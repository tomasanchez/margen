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
