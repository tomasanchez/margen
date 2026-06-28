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
 *     and the statement's normalized `bank` + `card` detail carried on each line
 *     (ADR-117);
 *   - a flagged (reconciler) line renders the "Possible duplicate" chip + the
 *     matched transaction inline, defaults to Merge (sending `resolution: 'merge'`
 *     + `matchTransactionId`), can switch to Keep both (`resolution: 'keep_both'`),
 *     drives the "N new · M merged" summary, and never re-matches an unflagged
 *     line (which still sends `resolution: 'import'`).
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
  type StatementImportResult,
  type StatementParse,
} from '../../api/statementsClient'
import { ImportStatement } from './ImportStatement'
import { clearParseCache } from './parseCache'

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

// The page navigates on "Done" / "Cancel"; stub useNavigate so it renders
// without a router and expose the spy so tests can assert navigation.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => navigateMock }
})

afterEach(() => {
  vi.clearAllMocks()
  // The parse cache is module-level + session-scoped; reset it between tests so
  // a result keyed by a filename in one test never leaks into the next.
  clearParseCache()
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
  card: 'VISA ·5771',
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
  // Every line is dated on the statement pay date (ADR-089); the original purchase
  // date is preserved per line in `purchaseDate`.
  lines: [
    {
      id: '0',
      occurredOn: '2026-06-19',
      purchaseDate: '2026-05-02',
      name: 'Carrefour',
      amount: 45000,
      currency: 'ARS',
      category: 'Food',
      lineKind: 'purchase',
      include: true,
    },
    {
      id: '1',
      occurredOn: '2026-06-19',
      purchaseDate: '2026-05-10',
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
      occurredOn: '2026-06-19',
      purchaseDate: '2026-05-20',
      name: 'Card fee',
      amount: 3000,
      currency: 'ARS',
      category: 'Fees',
      lineKind: 'fee',
      include: false,
    },
  ],
  document: documentPayload,
}

/**
 * A parse where one line (Netflix) likely duplicates an existing manual
 * transaction (ADR-084) — the reconciler path. The matched transaction differs
 * in name/date to exercise the inline match context + compare.
 */
const flaggedParse: StatementParse = {
  ...okParse,
  lines: [
    okParse.lines[0],
    {
      ...okParse.lines[1],
      match: {
        transactionId: 'tx-existing-1',
        name: 'Netflix monthly',
        occurredOn: '2026-05-09',
        amount: 8000,
        category: 'Subscriptions',
        paymentMethod: 'Galicia VISA ·5771',
      },
    },
    okParse.lines[2],
  ],
}

/** Build an import result in the new split-count shape (created vs merged). */
function importResult(
  overrides: Partial<StatementImportResult> = {},
): StatementImportResult {
  return {
    statementDocumentId: 'doc-1',
    createdCount: 0,
    mergedCount: 0,
    createdTransactionIds: [],
    mergedTransactionIds: [],
    ...overrides,
  }
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
    expect(await screen.findByText('Galicia · VISA ·5771')).toBeInTheDocument()
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

  test('each row shows both the paid (statement) date and the original purchase date', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    // The line is dated on the statement pay date (ADR-089); all three lines share it.
    expect(screen.getAllByText('paid Jun 19')).toHaveLength(3)
    // The original purchase date is shown per row beneath the pay date.
    expect(screen.getByText('bought May 02')).toBeInTheDocument()
    expect(screen.getByText('bought May 10')).toBeInTheDocument()
    expect(screen.getByText('bought May 20')).toBeInTheDocument()
    // A calm header note explains the two-date model.
    expect(
      screen.getByText(/dated when the card is paid/i),
    ).toBeInTheDocument()
  })
})

describe('Import statement — only the included lines are sent on import', () => {
  test('toggling a row off excludes it from the import payload', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    importStatementMock.mockResolvedValueOnce(importResult({ createdCount: 1 }))
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

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
    // The normalized bank + card detail are carried per line (ADR-117): `bank`
    // is the normalized bank ("Galicia", NOT the composite), `card` the detail.
    expect(payload.lines[0].bank).toBe('Galicia')
    expect(payload.lines[0].card).toBe('VISA ·5771')
    // Money is re-encoded as a Decimal string at the boundary.
    expect(payload.lines[0].amount).toBe('45000')
    // occurredOn stays the statement pay date; the original purchase date is echoed
    // back so the backend composes the purchase note (ADR-089).
    expect(payload.lines[0].occurredOn).toBe('2026-06-19')
    expect(payload.lines[0].purchaseDate).toBe('2026-05-02')
    // An unflagged kept line resolves as a plain import (no merge target).
    expect(payload.lines[0].resolution).toBe('import')
    expect(payload.lines[0].matchTransactionId).toBeUndefined()
    // The document echo is sent verbatim.
    expect(payload.document).toEqual(documentPayload)
  })

  test('editing a category is carried into the import payload', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    importStatementMock.mockResolvedValueOnce(importResult({ createdCount: 2 }))
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

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
    importStatementMock.mockResolvedValueOnce(importResult({ createdCount: 2 }))
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    await user.click(screen.getByRole('button', { name: 'Import 2 expenses' }))

    expect(
      await screen.findByRole('heading', { name: 'Imported 2 expenses' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Import another' }),
    ).toBeInTheDocument()
  })
})

describe('Import statement — reconciler flags likely duplicates', () => {
  test('a flagged line renders the duplicate chip + the matched transaction inline', async () => {
    parseStatementMock.mockResolvedValueOnce(flaggedParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    // The non-color cue: a "Possible duplicate" chip on the flagged row (ADR-019/086).
    expect(screen.getByText('Possible duplicate')).toBeInTheDocument()
    // The matched existing transaction is shown inline (name · date · amount),
    // using the app's shared date + money formatters (en-US short date, es-AR
    // grouped ARS), so it never drifts from how transactions read elsewhere.
    expect(
      screen.getByText('↔ "Netflix monthly" · May 09 · ARS 8.000'),
    ).toBeInTheDocument()
  })

  test('default resolution is Merge; the payload sends resolution + matchTransactionId', async () => {
    parseStatementMock.mockResolvedValueOnce(flaggedParse)
    importStatementMock.mockResolvedValueOnce(
      importResult({ createdCount: 1, mergedCount: 1 }),
    )
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    // Merge is pre-selected for the flagged row (ADR-086).
    expect(
      screen.getByRole('button', {
        name: /Merge Netflix into the existing transaction/i,
      }),
    ).toHaveAttribute('aria-pressed', 'true')

    // The CTA reads "Import N · merge M" when a merge is pending.
    await user.click(screen.getByRole('button', { name: 'Import 1 · merge 1' }))

    await waitFor(() => expect(importStatementMock).toHaveBeenCalledTimes(1))
    const [payload] = importStatementMock.mock.calls[0]
    const netflix = payload.lines.find(
      (l: { name: string }) => l.name === 'Netflix',
    )
    expect(netflix.resolution).toBe('merge')
    expect(netflix.matchTransactionId).toBe('tx-existing-1')
    // The unflagged Carrefour line still imports as new.
    const carrefour = payload.lines.find(
      (l: { name: string }) => l.name === 'Carrefour',
    )
    expect(carrefour.resolution).toBe('import')
    expect(carrefour.matchTransactionId).toBeUndefined()
  })

  test('switching a flagged row to Keep both sends resolution: keep_both (no merge target)', async () => {
    parseStatementMock.mockResolvedValueOnce(flaggedParse)
    importStatementMock.mockResolvedValueOnce(importResult({ createdCount: 2 }))
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    // Switch Netflix to Keep both.
    await user.click(
      screen.getByRole('button', {
        name: /Keep both — import Netflix as a separate expense/i,
      }),
    )

    // With no merge pending the CTA reverts to "Import 2 expenses".
    await user.click(screen.getByRole('button', { name: 'Import 2 expenses' }))

    await waitFor(() => expect(importStatementMock).toHaveBeenCalledTimes(1))
    const [payload] = importStatementMock.mock.calls[0]
    const netflix = payload.lines.find(
      (l: { name: string }) => l.name === 'Netflix',
    )
    expect(netflix.resolution).toBe('keep_both')
    expect(netflix.matchTransactionId).toBeUndefined()
  })

  test('the footer summary splits the kept lines into new vs merged', async () => {
    parseStatementMock.mockResolvedValueOnce(flaggedParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    // Carrefour (new) + Netflix (merge by default); the fee defaults excluded.
    expect(screen.getByText('1 new · 1 merged')).toBeInTheDocument()
  })

  test('a successful import with merges shows the created + merged confirmation', async () => {
    parseStatementMock.mockResolvedValueOnce(flaggedParse)
    importStatementMock.mockResolvedValueOnce(
      importResult({
        createdCount: 1,
        mergedCount: 1,
        createdTransactionIds: ['t-new'],
        mergedTransactionIds: ['tx-existing-1'],
      }),
    )
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    await screen.findByText('Galicia · VISA ·5771')

    await user.click(screen.getByRole('button', { name: 'Import 1 · merge 1' }))

    expect(
      await screen.findByRole('heading', {
        name: 'Imported 1 expense, merged 1 into existing transaction',
      }),
    ).toBeInTheDocument()
  })
})

describe('Import statement — Cancel discards the review and leaves the flow', () => {
  test('Cancel resets the parsed review back to the picker and navigates away', async () => {
    parseStatementMock.mockResolvedValueOnce(okParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile())
    // We're on the review step.
    await screen.findByText('Galicia · VISA ·5771')
    expect(screen.getByText('Carrefour')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    // The review is discarded — back to the empty/upload state.
    expect(
      await screen.findByRole('button', { name: 'Choose statement PDF' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Carrefour')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Import 2 expenses' }),
    ).not.toBeInTheDocument()
    // And it leaves the import flow.
    expect(navigateMock).toHaveBeenCalledWith({ to: '/transactions' })
  })
})

describe('Import statement — re-uploading the same file uses the cached parse', () => {
  test('re-picking the identical file does NOT trigger a second parse call', async () => {
    // Only ONE mocked resolution is queued — a second parse call would reject
    // (undefined), so the assertion below also guards against an extra call.
    parseStatementMock.mockResolvedValueOnce(okParse)
    const { user, fileInput } = renderImport()

    // The SAME File identity (name + size + lastModified) on both uploads.
    const file = pdfFile('same-statement.pdf')

    await user.upload(fileInput, file)
    await screen.findByText('Galicia · VISA ·5771')

    // Leave the review, then re-pick the very same file.
    await user.click(
      screen.getByRole('button', { name: 'Upload a different statement' }),
    )
    await screen.findByRole('button', { name: 'Choose statement PDF' })
    await user.upload(fileInput, file)

    // The cached parse is shown again the same way — no second network parse.
    expect(await screen.findByText('Galicia · VISA ·5771')).toBeInTheDocument()
    expect(screen.getByText('Carrefour')).toBeInTheDocument()
    expect(parseStatementMock).toHaveBeenCalledTimes(1)
  })

  test('uploading a different file DOES trigger a fresh parse', async () => {
    parseStatementMock.mockResolvedValue(okParse)
    const { user, fileInput } = renderImport()

    await user.upload(fileInput, pdfFile('first.pdf'))
    await screen.findByText('Galicia · VISA ·5771')

    await user.click(
      screen.getByRole('button', { name: 'Upload a different statement' }),
    )
    await screen.findByRole('button', { name: 'Choose statement PDF' })

    // A DIFFERENT file identity → cache miss → a second parse call.
    await user.upload(fileInput, pdfFile('second.pdf'))
    await screen.findByText('Galicia · VISA ·5771')

    expect(parseStatementMock).toHaveBeenCalledTimes(2)
  })
})
