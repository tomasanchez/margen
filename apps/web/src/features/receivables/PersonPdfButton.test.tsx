/**
 * Unit tests for the per-person PDF export affordance (ADR-209/211/212).
 *
 * The export DEFAULTS to OUTSTANDING-ONLY: the primary button is one tap and sends
 * NO `full` param (clean URL). A small caret menu offers "Outstanding" (default)
 * and "Full history" (which opts in with `full=true`). Both actions share one calm
 * pending/disabled state and one dismissible inline error (ADR-037). Driven against
 * a MOCKED {@link receivablesClient} (the network boundary); en-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { PersonPdfButton } from './PersonPdfButton'
import { receivablesClient } from '../../api/receivablesClient'

vi.mock('../../api/receivablesClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/receivablesClient')>()
  return {
    ...actual,
    receivablesClient: {
      ...actual.receivablesClient,
      downloadPersonPdf: vi.fn(),
    },
  }
})

const mockDownloadPdf = vi.mocked(receivablesClient.downloadPersonPdf)

function renderButton() {
  return render(
    <ColorModeProvider>
      <PersonPdfButton personId="p1" personName="Ana" />
    </ColorModeProvider>,
  )
}

describe('PersonPdfButton (ADR-212 outstanding default + full-history opt-in)', () => {
  beforeEach(() => {
    mockDownloadPdf.mockResolvedValue(undefined)
  })
  afterEach(() => vi.clearAllMocks())

  test('the primary button exports OUTSTANDING in one tap, WITHOUT the full flag', async () => {
    const user = userEvent.setup()
    renderButton()

    await user.click(
      screen.getByRole('button', { name: "Export Ana's receivables as a PDF" }),
    )

    // The default is outstanding-only: the helper is called with exactly three
    // args (no `full`) so the URL stays clean (ADR-212). The active UI language is
    // passed through as the 3rd arg (en-pinned suite, ADR-105).
    await waitFor(() =>
      expect(mockDownloadPdf).toHaveBeenCalledWith('p1', 'Ana', 'en'),
    )
    expect(mockDownloadPdf).toHaveBeenCalledTimes(1)
    expect(mockDownloadPdf.mock.calls[0]).toHaveLength(3)
  })

  test('the caret menu lists both modes; "Full history" opts in with full=true', async () => {
    const user = userEvent.setup()
    renderButton()

    await user.click(
      screen.getByRole('button', { name: /more export options/i }),
    )

    // Both modes are offered.
    expect(
      await screen.findByRole('menuitem', { name: 'Outstanding' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Full history' }))

    // Full history opts in with full=true (the 4th arg).
    await waitFor(() =>
      expect(mockDownloadPdf).toHaveBeenCalledWith('p1', 'Ana', 'en', true),
    )
  })

  test('the menu\'s "Outstanding" item exports WITHOUT the full flag', async () => {
    const user = userEvent.setup()
    renderButton()

    await user.click(
      screen.getByRole('button', { name: /more export options/i }),
    )
    await user.click(
      await screen.findByRole('menuitem', { name: 'Outstanding' }),
    )

    await waitFor(() =>
      expect(mockDownloadPdf).toHaveBeenCalledWith('p1', 'Ana', 'en'),
    )
    // No `full` arg on the default path (exactly three args).
    expect(mockDownloadPdf.mock.calls[0]).toHaveLength(3)
  })

  test('shows a pending label + disables both controls while exporting, then a calm dismissible error on failure', async () => {
    const user = userEvent.setup()
    // A download we can leave in-flight (to assert the pending/disabled state)
    // then reject (to assert the calm inline error, ADR-037).
    let rejectDownload!: (reason?: unknown) => void
    mockDownloadPdf.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectDownload = reject
      }),
    )
    renderButton()

    const exportButton = screen.getByRole('button', {
      name: "Export Ana's receivables as a PDF",
    })
    const caretButton = screen.getByRole('button', {
      name: /more export options/i,
    })
    await user.click(exportButton)

    // In-flight: both controls disable and the primary swaps to a pending label.
    expect(exportButton).toBeDisabled()
    expect(caretButton).toBeDisabled()
    expect(screen.getByText(/Preparing PDF/)).toBeInTheDocument()

    // Failure → a calm inline error (never throws into render, ADR-037).
    rejectDownload(new Error('boom'))
    expect(
      await screen.findByText(/We couldn't create the PDF/),
    ).toBeInTheDocument()
    // Back to idle: the controls re-enable so the owner can retry.
    await waitFor(() => expect(exportButton).toBeEnabled())

    // The error is dismissible (ADR-037).
    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() =>
      expect(screen.queryByText(/We couldn't create the PDF/)).toBeNull(),
    )
  })
})
