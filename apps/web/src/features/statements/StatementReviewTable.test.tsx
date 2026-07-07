/**
 * Interaction tests for the statement review table's USD-only line materialization
 * (ADR-079/148/149).
 *
 * A USD-only credit-card charge arrives from the parser with `usdAmount` set but
 * no peso `amount` and no FX (FX is left for review, ADR-079). At review the table
 * materializes its ARS-equivalent from the live preferred-source rate — the SAME
 * cached rate the Add-transaction flow uses (`usePreferredRate`) — computing
 * `amount = usdAmount × rate` and stamping `fxRate` + `fxRateType`, so the import
 * passes the `amount > 0` contract and the FX snapshot is complete. When the rate
 * is unavailable the amount stays blank and a calm hint asks for a manual amount;
 * a rate is never fabricated (ADR-149/150).
 *
 * The FX + settings hooks are mocked so the rate is deterministic; the account /
 * institution / net-worth reads fall back to empty (the default rejecting fetch),
 * which is enough — these tests assert the amount cell + import payload, not the
 * card-attachment or payment plan. English-pinned (ADR-105).
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import type { StatementParse } from '../../api/statementsClient'
import { StatementReviewTable } from './StatementReviewTable'

// The materialization rate comes from usePreferredRate + the preferred source from
// useSettings. Mock both so the rate is deterministic and no network is hit.
const { preferredRateMock, settingsMock } = vi.hoisted(() => ({
  preferredRateMock: vi.fn(),
  settingsMock: vi.fn(),
}))

vi.mock('../budgets/queries', async () => {
  const actual =
    await vi.importActual<typeof import('../budgets/queries')>('../budgets/queries')
  return { ...actual, usePreferredRate: preferredRateMock }
})

vi.mock('../settings/queries', async () => {
  const actual =
    await vi.importActual<typeof import('../settings/queries')>('../settings/queries')
  return { ...actual, useSettings: settingsMock }
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A parse with a USD-only line (no peso amount) + an ARS line (ADR-079). */
function usdOnlyParse(): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    bankName: 'Santander',
    network: 'AMEX',
    cardLast4: '1234',
    card: 'AMEX ·1234',
    naturalKey: null,
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
    lines: [
      {
        id: '0',
        occurredOn: '2026-06-10',
        name: 'Coto',
        amount: 45000,
        currency: 'ARS',
        lineKind: 'purchase',
        include: true,
      },
      {
        id: '1',
        occurredOn: '2026-06-10',
        name: 'AWS',
        amount: 0,
        currency: 'USD',
        usdAmount: 200,
        lineKind: 'purchase',
        include: true,
      },
    ],
  }
}

/** Seed the rate + source hooks (mimicking the resolved query shape). */
function seedRate(rate: number | null, source: 'bolsa' | 'oficial' = 'bolsa') {
  preferredRateMock.mockReturnValue({ data: rate })
  settingsMock.mockReturnValue({ data: { preferredRateSource: source } })
}

/** Render the review table with a spyable onImport. */
function renderReview(parse: StatementParse) {
  const onImport = vi.fn()
  const user = userEvent.setup()
  renderWithProviders(
    <StatementReviewTable parse={parse} onImport={onImport} isImporting={false} />,
  )
  return { onImport, user }
}

describe('StatementReviewTable — USD-only line materialization (ADR-079)', () => {
  test('materializes the ARS amount from the live rate and imports amount > 0', async () => {
    seedRate(1245, 'bolsa')
    const { onImport, user } = renderReview(usdOnlyParse())

    // The materialized ARS amount fills the editable field (200 × 1245 = 249000);
    // the applied rate is surfaced beyond color in the row.
    const arsField = (await screen.findByLabelText(
      'Peso amount for AWS',
    )) as HTMLInputElement
    await waitFor(() => expect(arsField.value).toBe('249000'))

    // Import sends the materialized amount + a complete FX snapshot for the USD line.
    await user.click(screen.getByRole('button', { name: /Import 2 expenses/i }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [request] = onImport.mock.calls[0]
    const aws = request.lines.find((l: { name: string }) => l.name === 'AWS')
    expect(aws.amount).toBe('249000')
    expect(aws.usdAmount).toBe('200')
    expect(aws.fxRate).toBe('1245')
    expect(aws.fxRateType).toBe('MEP')
    // The ARS line is untouched.
    const coto = request.lines.find((l: { name: string }) => l.name === 'Coto')
    expect(coto.amount).toBe('45000')
    expect('fxRate' in coto).toBe(false)
  })

  test('lets the user override the materialized ARS amount before import', async () => {
    seedRate(1245, 'bolsa')
    const { onImport, user } = renderReview(usdOnlyParse())

    const arsField = screen.getByLabelText('Peso amount for AWS') as HTMLInputElement
    await waitFor(() => expect(arsField.value).toBe('249000'))

    await user.clear(arsField)
    await user.type(arsField, '250000')

    await user.click(screen.getByRole('button', { name: /Import 2 expenses/i }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [request] = onImport.mock.calls[0]
    const aws = request.lines.find((l: { name: string }) => l.name === 'AWS')
    expect(aws.amount).toBe('250000')
  })

  test('rate unavailable: shows the calm hint and leaves the ARS amount blank', async () => {
    seedRate(null, 'bolsa')
    renderReview(usdOnlyParse())

    // A blank ARS field + a per-row prompt; no fabricated rate.
    const arsField = (await screen.findByLabelText(
      'Peso amount for AWS',
    )) as HTMLInputElement
    expect(arsField.value).toBe('')
    // The table-level calm hint appears (info, non-blocking).
    expect(
      screen.getByText(/couldn't get today's exchange rate/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Enter peso amount')).toBeInTheDocument()
  })

  test('rate unavailable: a manual ARS amount imports with amount > 0', async () => {
    seedRate(null, 'bolsa')
    const { onImport, user } = renderReview(usdOnlyParse())

    const arsField = (await screen.findByLabelText(
      'Peso amount for AWS',
    )) as HTMLInputElement
    await user.type(arsField, '260000')

    await user.click(screen.getByRole('button', { name: /Import 2 expenses/i }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [request] = onImport.mock.calls[0]
    const aws = request.lines.find((l: { name: string }) => l.name === 'AWS')
    expect(aws.amount).toBe('260000')
    // No rate was fabricated for the manual entry (ADR-149/150).
    expect('fxRate' in aws).toBe(false)
  })
})
