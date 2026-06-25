/**
 * Render checks for the desktop transaction row's FX source indicator
 * (ADR-044/045). A USD row keeps the gold "FX" badge and its <Amount> subline
 * shows the rate value AND its source — "MEP" for a confirmed suggestion,
 * "manual" for a user-entered/overridden rate — so the user always knows
 * "which dollar". An ARS row shows no FX subline.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { TransactionRow } from './TransactionRow'
import type { Transaction } from '../../mock/types'
import * as invoicesClient from '../../api/invoicesClient'

const baseUsd: Transaction = {
  id: 'usd-1',
  occurredOn: '2026-06-12',
  dispDate: 'Jun 12',
  month: 'June',
  name: 'Invoice · Atlas Co.',
  category: 'Income',
  bank: 'Transfer',
  currency: 'USD',
  type: 'income',
  kind: 'invoice',
  amountNum: 622500,
  usd: 500,
  rate: 1245,
  fxRateType: 'MEP',
}

function renderRow(t: Transaction) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <TransactionRow transaction={t} onEdit={() => {}} onDelete={() => {}} />
    </ThemeProvider>,
  )
}

test('a USD row from a confirmed MEP suggestion shows the FX badge + "MEP" source', () => {
  renderRow(baseUsd)
  expect(screen.getByText('FX')).toBeInTheDocument()
  expect(screen.getByText('USD 500 · MEP 1.245')).toBeInTheDocument()
})

test('the FX badge exposes an accessible "Foreign exchange" name + explanatory tooltip', () => {
  renderRow(baseUsd)
  // Screen readers / keyboard users get the meaning of "FX" via the accessible
  // name and the same string as the (hover/focus) tooltip title (ADR-019).
  const badge = screen.getByLabelText('Foreign exchange')
  expect(badge).toHaveTextContent('FX')
  // Reachable without a mouse — the tooltip opens on focus.
  expect(badge).toHaveAttribute('tabindex', '0')
})

test('a USD row with a manual rate shows the "manual" source', () => {
  renderRow({ ...baseUsd, rate: 1300, amountNum: 650000, fxRateType: 'manual' })
  expect(screen.getByText('USD 500 · manual 1.300')).toBeInTheDocument()
})

test('a USD row from the official dollar shows the "official" source', () => {
  renderRow({ ...baseUsd, rate: 1045, amountNum: 522500, fxRateType: 'official' })
  expect(screen.getByText('USD 500 · official 1.045')).toBeInTheDocument()
})

test('an ARS row shows no FX badge or subline', () => {
  renderRow({
    ...baseUsd,
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    usd: undefined,
    rate: undefined,
    fxRateType: undefined,
  })
  expect(screen.queryByText('FX')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Foreign exchange')).not.toBeInTheDocument()
  expect(screen.queryByText(/· (MEP|manual)/)).not.toBeInTheDocument()
})

// Invoice attachment badge (ADR-072, ADR-092): a kind === 'invoice' row surfaces
// an accessible "PDF" button that fetches the stored document WITH the bearer
// token (the routes are auth-gated, so a plain <a href> would 401) and opens the
// blob in a new tab; non-invoice rows do not.
describe('invoice attachment badge', () => {
  beforeEach(() => {
    vi.spyOn(invoicesClient, 'fetchInvoiceDocument')
    vi.stubGlobal('open', vi.fn(() => ({}) as Window))
    // jsdom does not implement the object-URL APIs.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('renders an accessible PDF button (not a plain link)', () => {
    renderRow({ ...baseUsd, kind: 'invoice' })

    const badge = screen.getByRole('button', {
      name: 'Open invoice PDF for Invoice · Atlas Co.',
    })
    // It is a button, not an <a href> (the authed fetch attaches the token).
    expect(badge.tagName).toBe('BUTTON')
    expect(screen.queryByRole('link', { name: /Open invoice PDF/i })).toBeNull()
    // Carries a text label, not color alone (ADR-019).
    expect(badge).toHaveTextContent('PDF')
  })

  test('clicking fetches the document via the authed client and opens the blob', async () => {
    const user = userEvent.setup()
    vi.mocked(invoicesClient.fetchInvoiceDocument).mockResolvedValueOnce(
      new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    )
    renderRow({ ...baseUsd, kind: 'invoice' })

    await user.click(
      screen.getByRole('button', {
        name: 'Open invoice PDF for Invoice · Atlas Co.',
      }),
    )

    // The authed client fetcher ran for THIS transaction id.
    await waitFor(() =>
      expect(invoicesClient.fetchInvoiceDocument).toHaveBeenCalledWith('usd-1'),
    )
    // The blob became a short-lived object URL, opened in a new tab.
    await waitFor(() =>
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1),
    )
    expect(window.open).toHaveBeenCalledWith(
      'blob:mock-url',
      '_blank',
      'noopener,noreferrer',
    )
  })

  test('a failed fetch shows a calm error (no crash) and does not open a tab', async () => {
    const user = userEvent.setup()
    vi.mocked(invoicesClient.fetchInvoiceDocument).mockRejectedValueOnce(
      new invoicesClient.InvoicesApiError(401, 'Your session expired.'),
    )
    renderRow({ ...baseUsd, kind: 'invoice' })

    await user.click(
      screen.getByRole('button', {
        name: 'Open invoice PDF for Invoice · Atlas Co.',
      }),
    )

    // The calm error surfaces (here via the tooltip title) and no tab opened.
    await waitFor(() =>
      expect(screen.getByText('Your session expired.')).toBeInTheDocument(),
    )
    expect(window.open).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('a non-invoice row renders no attachment badge', () => {
    renderRow({
      ...baseUsd,
      type: 'expense',
      kind: 'expense',
      category: 'Food',
    })
    expect(
      screen.queryByRole('button', { name: /Open invoice PDF/i }),
    ).toBeNull()
  })
})

// Notes indicator (ADR-088/089, ADR-019): a row whose `notes` carry statement
// installment detail surfaces a small, focusable notes icon whose accessible
// name + (hover/focus) tooltip expose the note without a mouse. A row with no
// notes shows no indicator (no empty affordance).
describe('notes indicator', () => {
  const note = 'Compra 20-03-26 · Cuota 03/03'

  test('a row with notes renders a focusable indicator that exposes the note', () => {
    renderRow({ ...baseUsd, notes: note })

    // Reachable by accessible name (label prefix + the note data itself),
    // keyboard-focusable so the tooltip opens on focus (ADR-019).
    const indicator = screen.getByRole('note', { name: `Notes: ${note}` })
    expect(indicator).toHaveAttribute('tabindex', '0')

    // The note text is also the tooltip title, shown on hover/focus.
    expect(indicator).toHaveAttribute('aria-label', `Notes: ${note}`)
  })

  test('a row without notes renders no indicator', () => {
    renderRow({ ...baseUsd, notes: undefined })
    expect(screen.queryByRole('note')).toBeNull()
  })

  test('an empty/whitespace note renders no indicator', () => {
    renderRow({ ...baseUsd, notes: '   ' })
    expect(screen.queryByRole('note')).toBeNull()
  })
})
