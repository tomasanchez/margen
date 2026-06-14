/**
 * Interaction tests for the in-form ARCA PDF invoice import (ADR-070, ADR-072,
 * ADR-074).
 *
 * The upload now lives ON the invoice input inside the shared Add/Edit form
 * (issue #26): opening Add → Invoice/income reveals an "Upload ARCA invoice PDF
 * to autofill" control with a hidden PDF picker. Picking a file calls the mocked
 * parse client (ADR-038) and AUTOFILLS the form fields; the user reviews and
 * decides whether to save (the parse is non-committal). These tests assert the
 * AC-critical behaviors:
 *   - a successful parse autofills the form (income · invoice, amount, date, …);
 *   - confirming the form calls create WITH the base64 `document` payload;
 *   - `duplicate: true` renders the calm, non-blocking duplicate Alert and save
 *     is still allowed;
 *   - an `unparseable` result OR a 415/413/422 InvoicesApiError shows the calm
 *     inline message and the form stays usable (no navigation, no dialog close).
 *
 * The HTTP clients are fully mocked (no network); FX + settings are mocked as in
 * the Add/Edit flow test so USD prefills seed without a real dolarapi call.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { useAddTransaction } from './addContext'
import { InvoicesApiError, type InvoiceParse } from '../../api/invoicesClient'

// Mock the HTTP clients so the flow never touches a real backend (ADR-038), and
// the dolarapi FX adapter + settings so USD prefills seed without real network.
const { createMock, parseInvoiceMock, fxMock, fetchSettingsMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    parseInvoiceMock: vi.fn(),
    fxMock: vi.fn(),
    fetchSettingsMock: vi.fn(),
  }),
)

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: vi.fn(() => Promise.resolve([])),
    create: createMock,
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

// Keep InvoicesApiError real (the form does `instanceof` on it); only the
// network call (parseInvoice) is mocked.
vi.mock('../../api/invoicesClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/invoicesClient')>(
      '../../api/invoicesClient',
    )
  return { ...actual, parseInvoice: parseInvoiceMock }
})

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: fxMock,
}))

vi.mock('../../api/settingsClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/settingsClient')>(
      '../../api/settingsClient',
    )
  return { ...actual, fetchSettings: fetchSettingsMock }
})

beforeEach(() => {
  fxMock.mockResolvedValue({ mep: 1245, official: 1045 })
  fetchSettingsMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A picked PDF File (the multipart `file` the upload would carry). */
function pdfFile(name = 'invoice.pdf'): File {
  return new File(['%PDF-1.7\n'], name, { type: 'application/pdf' })
}

/** The base64 document payload the client would build from the uploaded File. */
const documentPayload = {
  pdfBase64: 'ZmFrZS1iYXNlNjQ=',
  contentType: 'application/pdf',
  emisorCuit: '20304050607',
  ptoVta: '3',
  tipoCmp: '11',
  nroCmp: '142',
  fecha: '2026-05-20',
  importe: 45000,
  moneda: 'ARS',
}

/** A successful ARS parse result (the adapter's form-ready shape). */
const arsParse: InvoiceParse = {
  status: 'ok_qr',
  duplicate: false,
  naturalKey: { emisorCuit: '20304050607', ptoVta: 3, tipoCmp: 11, nroCmp: 142 },
  occurredOn: '2026-05-20',
  name: 'Atlas Co.',
  amount: 45000,
  currency: 'ARS',
  category: 'Income',
  countsTowardMonotributo: true,
  document: documentPayload,
}

/** A trigger that opens the Add/Edit flow on the Invoice/income tab. */
function OpenIncomeTrigger() {
  const { openAdd } = useAddTransaction()
  return (
    <button
      type="button"
      onClick={() => openAdd({ type: 'income', kind: 'invoice' })}
    >
      open income
    </button>
  )
}

/**
 * Open the Add/Edit dialog on the Invoice/income tab and return the dialog +
 * its hidden PDF file input + a userEvent session.
 */
async function openIncomeForm() {
  const user = userEvent.setup()
  renderWithProviders(<OpenIncomeTrigger />, { withAddProvider: true })

  await user.click(screen.getByRole('button', { name: 'open income' }))
  const dialog = await screen.findByRole('dialog')
  // The upload control is present on the income input.
  await within(dialog).findByRole('button', {
    name: /Upload ARCA invoice PDF to autofill/i,
  })
  const fileInput = dialog.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement
  return { user, dialog, fileInput }
}

describe('In-form upload — a successful parse autofills the invoice fields', () => {
  test('picking a PDF autofills the income invoice fields with the extracted values', async () => {
    parseInvoiceMock.mockResolvedValueOnce(arsParse)
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())

    // The extracted ARS amount + date are autofilled.
    await waitFor(() =>
      expect(form.getByLabelText(/^Amount in /)).toHaveValue('45000'),
    )
    expect(form.getByLabelText('Transaction date')).toHaveValue('2026-05-20')
    // Still the invoice / income surface; the Monotributo control is on.
    expect(
      form.getByRole('heading', { name: 'New invoice · income' }),
    ).toBeInTheDocument()
    expect(form.getByText('Counts toward Monotributo')).toBeInTheDocument()
    // parseInvoice received the picked File.
    expect(parseInvoiceMock).toHaveBeenCalledTimes(1)
    expect(parseInvoiceMock.mock.calls[0][0]).toBeInstanceOf(File)
  })

  test('confirming the autofilled form calls create WITH the document payload', async () => {
    parseInvoiceMock.mockResolvedValueOnce(arsParse)
    createMock.mockResolvedValueOnce({})
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())
    await waitFor(() =>
      expect(form.getByLabelText(/^Amount in /)).toHaveValue('45000'),
    )

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    const [input] = createMock.mock.calls[0]
    // The create carries the imported invoice as income · invoice WITH the PDF.
    expect(input.type).toBe('income')
    expect(input.kind).toBe('invoice')
    expect(input.document).toEqual(documentPayload)
    expect(input.document.pdfBase64).toBe('ZmFrZS1iYXNlNjQ=')
    expect(input.document.emisorCuit).toBe('20304050607')
    expect(input.document.nroCmp).toBe('142')
    // The extracted invoice name is carried through.
    expect(input.name).toBe('Atlas Co.')
  })
})

describe('In-form upload — duplicate is a calm, non-blocking warning', () => {
  test('a duplicate parse renders the duplicate Alert and saving is still allowed', async () => {
    parseInvoiceMock.mockResolvedValueOnce({ ...arsParse, duplicate: true })
    createMock.mockResolvedValueOnce({})
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())

    // The calm, non-blocking duplicate notice is shown after autofill.
    expect(
      await form.findByText(/already imported this invoice/i),
    ).toBeInTheDocument()
    // Save is NOT blocked by the duplicate warning.
    const save = form.getByRole('button', { name: /^Save$/ })
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock.mock.calls[0][0].document).toEqual(documentPayload)
  })
})

describe('In-form upload — calm inline error keeps the form usable', () => {
  test('an unparseable result shows the calm inline message; the form stays open and editable', async () => {
    parseInvoiceMock.mockResolvedValueOnce({
      status: 'unparseable',
      duplicate: false,
      naturalKey: null,
      document: { pdfBase64: 'x', contentType: 'application/pdf' },
    } satisfies InvoiceParse)
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())

    // Calm inline message under the upload control — not a navigation/dialog close.
    expect(
      await form.findByText(/enter the details manually/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // The form stays usable: the user fills the amount manually and can save.
    createMock.mockResolvedValueOnce({})
    await user.type(form.getByLabelText(/^Amount in /), '5000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    // No document attached when the parse failed.
    expect(createMock.mock.calls[0][0].document).toBeUndefined()
  })

  test('a 415 rejection shows that-file-is-not-a-PDF copy and the form stays usable', async () => {
    parseInvoiceMock.mockRejectedValueOnce(
      new InvoicesApiError(
        415,
        'That file is not a PDF. Upload the ARCA invoice PDF, or enter it manually.',
      ),
    )
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())

    expect(await form.findByText(/not a PDF/i)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('a 422 rejection shows the calm could-not-read copy, no dialog close', async () => {
    parseInvoiceMock.mockRejectedValueOnce(
      new InvoicesApiError(
        422,
        "Couldn't read this as an ARCA invoice. You can enter it manually.",
      ),
    )
    const { user, dialog, fileInput } = await openIncomeForm()
    const form = within(dialog)

    await user.upload(fileInput, pdfFile())

    expect(
      await form.findByText(/Couldn't read this as an ARCA invoice/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('the upload control is hidden on the expense tab (expenses are not invoices)', async () => {
    const { user, dialog } = await openIncomeForm()
    const form = within(dialog)

    await user.click(form.getByRole('button', { name: 'Expense' }))
    expect(
      form.queryByRole('button', {
        name: /Upload ARCA invoice PDF to autofill/i,
      }),
    ).not.toBeInTheDocument()
  })
})
