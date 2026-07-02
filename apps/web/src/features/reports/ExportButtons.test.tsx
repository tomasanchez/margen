/**
 * Render tests for {@link ExportButtons} (ADR-165).
 *
 * The two buttons trigger authed CSV downloads via {@link useReportDownload}.
 * These tests mock the reports client fetchers and stub the object-URL / anchor
 * APIs, then assert: clicking "Export transactions" calls the transactions
 * fetcher and saves under the transactions filename; clicking "Export category
 * summary" calls the summary fetcher for the month; and a failed fetch surfaces a
 * calm inline error. English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { ExportButtons } from './ExportButtons'
import { reportsClient } from '../../api/reportsClient'

vi.mock('../../api/reportsClient', () => ({
  reportsClient: {
    fetchTransactionsCsv: vi.fn(),
    fetchSummaryCsv: vi.fn(),
  },
}))

const mockedClient = vi.mocked(reportsClient)

function renderButtons() {
  return render(
    <ThemeProvider theme={darkTheme}>
      <ExportButtons month="2026-06" />
    </ThemeProvider>,
  )
}

describe('<ExportButtons>', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mockedClient.fetchTransactionsCsv.mockResolvedValue(
      new Blob(['id,name'], { type: 'text/csv' }),
    )
    mockedClient.fetchSummaryCsv.mockResolvedValue(
      new Blob(['category,amount_ars'], { type: 'text/csv' }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  test('exporting transactions calls the transactions fetcher and saves the file', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    renderButtons()

    await userEvent.click(
      screen.getByRole('button', { name: /transactions csv/i }),
    )

    await waitFor(() =>
      expect(mockedClient.fetchTransactionsCsv).toHaveBeenCalledTimes(1),
    )
    expect(mockedClient.fetchSummaryCsv).not.toHaveBeenCalled()
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('margen-transactions-all-all.csv')
  })

  test('exporting the summary calls the summary fetcher for the month', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    renderButtons()

    await userEvent.click(
      screen.getByRole('button', { name: /category summary csv/i }),
    )

    await waitFor(() =>
      expect(mockedClient.fetchSummaryCsv).toHaveBeenCalledWith('2026-06'),
    )
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('margen-summary-2026-06.csv')
  })

  test('a failed export surfaces a calm inline error', async () => {
    mockedClient.fetchTransactionsCsv.mockRejectedValue(new Error('boom'))
    renderButtons()

    await userEvent.click(
      screen.getByRole('button', { name: /transactions csv/i }),
    )

    expect(
      await screen.findByText(/Couldn't prepare the download/i),
    ).toBeInTheDocument()
  })
})
