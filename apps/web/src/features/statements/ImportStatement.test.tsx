/**
 * Interaction tests for the CC-statement import flow (ADR-078, ADR-080).
 *
 * The flow lives on its own routed page: a PDF picker uploads a statement to the
 * mocked parse client; on `ok` it renders the multi-row review table; on
 * `unsupported`/`unparseable` (or a 415/413/422 rejection) it shows a CALM inline
 * message and keeps the screen usable (no crash). These tests assert the
 * AC-critical behaviors:
 *   - a successful parse renders the review table with the detected identity +
 *     a row per parsed line;
 *   - toggling a row off excludes it from the import payload;
 *   - editing a category is carried into the import payload;
 *   - `duplicate: true` renders the calm, non-blocking duplicate warning;
 *   - an `unsupported`/`unparseable` result shows the calm fallback message and
 *     the picker stays usable;
 *   - importing calls the client with ONLY the included lines, the document echo,
 *     and the card payment method carried as each line's `bank`.
 *
 * The statements HTTP client is mocked (no network); `useNavigate` is mocked so
 * the page renders standalone via renderWithProviders (no router needed).
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import {
  StatementsApiError,
  type StatementParse,
} from '../../api/statementsClient'
import { ImportStatement } from './ImportStatement'

// Mock the statements client so the flow never touches a real backend. Keep
// StatementsApiError real (the flow does `instanceof` on it); only the network
// calls (parseStatement / importStatement) are mocked.
const { parseStatementMock, importStatementMock } = vi.hoisted(() => ({
  parseStatementMock: vi.fn(),
  importStatementMock: vi.fn(),
}))

vi.mock('../../api/statementsClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/statementsClient')>(
      '../../api/statementsClient',
    )
  return {
    ...actual,
    parseStatement: parseStatementMock,
    importStatement: importStatementMock,
    statementsClient: {
      ...actual.statementsClient,
      parseStatement: parseStatementMock,
      importStatement: importStatementMock,
    },
  }
})

// The page navigates on "Done"; stub useNavigate so it renders without a router.
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => vi.fn() }
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A picked PDF File (the multipart `file` the upload would carry). */
function pdfFile(name = 'statement.pdf'): File {
  return new File(['%PDF-1.7\n'], name, { type: 'application/pdf' })
}

/** The document echo the client would build from the uploaded File. */
const documentPayload = {
  pdfBase64: 'ZmFrZS1iYXNlNjQ=',
  contentType: 'application/pdf',
  bankName: 'Galicia',
  network: 'VISA',
  cardLast4: '5771',
  statementNumber: 'A-1000',
  periodClose: '2026-05-20',
  periodDue: '2026-06-05',
  totalAmount: '128000.00',
}

/** A successful parse with three lines (one fee, one default-excluded). */
const okParse: StatementParse = {
  status: 'ok',
  duplicate: false,
  bankName: 'Galicia',
  network: 'VISA',
  cardLast4: '5771',
  paymentMethod: 'Galicia VISA ·5771',
  statementNumber: 'A-1000',
  issuerCuit: '20304050607',
  periodClose: '2026-05-20',
  periodDue: '2026-06-05',
  totalAmount: 128000,
  naturalKey: {
    issuerCuit: '20304050607',
    cardLast4: '5771',
    statementNumber: 'A-1000',
  },
  lines: [
    {
      id: '0',
      occurredOn: '2026-05-02',
      name: 'Carrefour',
      amount: 45000,
      currency: 'ARS',
      category: 'Food',
      lineKind: 'purchase',
      include: true,
    },
    {
      id: '1',
      occurredOn: '2026-05-10',
      name: 'Netflix',
      amount: 8000,
      currency: 'ARS',
      category: 'Subscriptions',
      cuota: '1/1',
      lineKind: 'purchase',
      include: true,
    },
    {
      id: '2',
      occurredOn: '2026-05-20',
      name: 'Card fee',
      amount: 3000,
      currency: 'ARS',
      category: 'Fee',
      lineKind: 'fee',
      include: false,
    },
  ],
  document: documentPayload,
}

/** Render the page and return a userEvent session + the hidden PDF file input. */
function renderImport() {
  const user = userEvent.setup()
  const result = renderWithProviders(<ImportStatement />)
  const fileInput = result.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement
  return { user, fileInput }
}

describe('Import statement — a successful parse renders the review table', () => {
  test('picking a PDF renders the detected identity and a row per line', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())

    // The detected card identity appears in the header strip.
    expect(await screen.findByText('Galicia VISA ·5771')).toBeInTheDocument()
    // A row per parsed line.
    expect(screen.getByText('Carrefour')).toBeInTheDocument()
    expect(screen.getByText('Netflix')).toBeInTheDocument()
    expect(screen.getByText('Card fee')).toBeInTheDocument()
    // The included default (2 of 3, the fee defaults excluded) drives the CTA.
    expect(
      screen.getByRole('button', { name: 'Import 2 expenses' }),
    ).toBeInTheDocument()
    // parseStatement received the picked File.
    expect(parseStatementMock).toHaveBeenCalledTimes(1)
    expect(parseStatementMock.mock.calls[0][0]).toBeInstanceOf(File)
  })
})

describe('Import statement — only the included lines are sent on import', () => {
  test('toggling a row off excludes it from the import payload', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    importStatementMock.mockResolvedValueOnce({
      statementDocumentId: 'doc-1',
      createdCount: 1,
      transactionIds: ['t1'],
    })
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia VISA ·5771')

    // Toggle Netflix off (it defaults included). Its switch is labelled by name.
    await user.click(
      screen.getByRole('switch', {
        name: /Skip Netflix — currently set to import/i,
      }),
    )

    // Only Carrefour remains; the CTA reflects 1 expense.
    const importBtn = await screen.findByRole('button', {
      name: 'Import 1 expense',
    })
    await user.click(importBtn)

    await waitFor(() => expect(importStatementMock).toHaveBeenCalledTimes(1))
    const [payload] = importStatementMock.mock.calls[0]
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0].name).toBe('Carrefour')
    // The card payment method is carried as the line's bank.
    expect(payload.lines[0].bank).toBe('Galicia VISA ·5771')
    // Money is re-encoded as a Decimal string at the boundary.
    expect(payload.lines[0].amount).toBe('45000')
    // The document echo is sent verbatim.
    expect(payload.document).toEqual(documentPayload)
  })

  test('editing a category is carried into the import payload', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    importStatementMock.mockResolvedValueOnce({
      statementDocumentId: 'doc-1',
      createdCount: 2,
      transactionIds: ['t1', 't2'],
    })
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia VISA ·5771')

    // Change Carrefour's category from Food to Shopping via its labelled Select.
    const carrefourSelect = screen.getByLabelText('Category for Carrefour')
    await user.click(within(carrefourSelect).getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Shopping' }))

    await user.click(screen.getByRole('button', { name: 'Import 2 expenses' }))

    await waitFor(() => expect(importStatementMock).toHaveBeenCalledTimes(1))
    const [payload] = importStatementMock.mock.calls[0]
    const carrefourLine = payload.lines.find(
      (l: { name: string }) => l.name === 'Carrefour',
    )
    expect(carrefourLine.category).toBe('Shopping')
  })
})

describe('Import statement — duplicate is a calm, non-blocking warning', () => {
  test('a duplicate parse renders the duplicate notice; import is still allowed', async () => {
    parseStatementMock.mockResolvedValueOnce({ ...okParse, duplicate: true })
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())

    expect(
      await screen.findByText(/already imported this statement/i),
    ).toBeInTheDocument()
    // The import action is NOT blocked by the duplicate warning.
    expect(
      screen.getByRole('button', { name: 'Import 2 expenses' }),
    ).toBeEnabled()
  })
})

describe('Import statement — calm fallback keeps the screen usable', () => {
  test('an unsupported result shows the calm bank-not-supported message', async () => {
    parseStatementMock.mockResolvedValueOnce({
      status: 'unsupported',
      duplicate: false,
      naturalKey: null,
      lines: [],
      document: { pdfBase64: 'x', contentType: 'application/pdf' },
    } satisfies StatementParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())

    expect(
      await screen.findByText(/isn't supported yet/i),
    ).toBeInTheDocument()
    // The picker stays usable (no crash, no review table).
    expect(
      screen.getByRole('button', { name: 'Choose statement PDF' }),
    ).toBeInTheDocument()
  })

  test('an unparseable result shows the calm could-not-read message', async () => {
    parseStatementMock.mockResolvedValueOnce({
      status: 'unparseable',
      duplicate: false,
      naturalKey: null,
      lines: [],
      document: { pdfBase64: 'x', contentType: 'application/pdf' },
    } satisfies StatementParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())

    expect(
      await screen.findByText(/couldn't read this statement automatically/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Choose statement PDF' }),
    ).toBeInTheDocument()
  })

  test('a 415 rejection shows the calm not-a-PDF copy and the picker stays', async () => {
    parseStatementMock.mockRejectedValueOnce(
      new StatementsApiError(
        415,
        'That file is not a PDF. Upload the card statement PDF, or add expenses manually.',
      ),
    )
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())

    expect(await screen.findByText(/not a PDF/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Choose statement PDF' }),
    ).toBeInTheDocument()
  })
})

describe('Import statement — success shows a calm confirmation', () => {
  test('a successful import shows the imported-count confirmation', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    importStatementMock.mockResolvedValueOnce({
      statementDocumentId: 'doc-1',
      createdCount: 2,
      transactionIds: ['t1', 't2'],
    })
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia VISA ·5771')

    await user.click(screen.getByRole('button', { name: 'Import 2 expenses' }))

    expect(
      await screen.findByRole('heading', { name: 'Imported 2 expenses' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Import another' }),
    ).toBeInTheDocument()
  })
})
