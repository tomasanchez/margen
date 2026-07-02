/**
 * Render tests for {@link CommitmentsList} (ADR-176, ADR-177).
 *
 * The upcoming-commitments / installments-tail view: the committed streams grouped
 * by source (subscriptions, installments). Asserts each group heading appears for a
 * non-empty group, an installment row shows its remaining-cuota count (the
 * load-bearing "N left" signal, never colour), amounts render in each line's OWN
 * currency, the monotributo `tax` cuota is NOT listed here (it lives on the
 * Monotributo trajectory card, ADR-177), an empty group is omitted, and no
 * commitments at all degrades to a calm note. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { CommitmentsList } from './CommitmentsList'
import type { CommitmentLine } from '../../api/forecastClient'

const commitments: CommitmentLine[] = [
  {
    source: 'subscription',
    label: 'Netflix',
    amount: 5000,
    currency: 'ARS',
    arsFixed: false,
    months: ['2026-08', '2026-09'],
    remainingCount: null,
  },
  {
    source: 'tax',
    label: 'Monotributo',
    amount: 85_000,
    currency: 'ARS',
    arsFixed: true,
    months: ['2026-08', '2026-09'],
    remainingCount: null,
  },
  {
    source: 'installment',
    label: 'Samsung TV',
    amount: 30_000,
    currency: 'ARS',
    arsFixed: false,
    months: ['2026-08'],
    remainingCount: 9,
  },
]

function renderList(lines: CommitmentLine[]) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <CommitmentsList commitments={lines} />
    </ThemeProvider>,
  )
}

describe('<CommitmentsList>', () => {
  test('groups by source and shows each non-empty group heading', () => {
    renderList(commitments)

    expect(screen.getByRole('list', { name: 'Subscriptions' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Installments' })).toBeInTheDocument()
    expect(screen.getByText('Netflix')).toBeInTheDocument()
  })

  test('does NOT list the monotributo tax cuota (it lives on the trajectory card)', () => {
    renderList(commitments)

    // The tax cuota is a fixed AFIP-ARS obligation surfaced separately (ADR-177),
    // so neither a Taxes group nor the mislabelled amount appears here.
    expect(screen.queryByRole('list', { name: 'Taxes' })).not.toBeInTheDocument()
    expect(screen.queryByText('Monotributo')).not.toBeInTheDocument()
    expect(screen.queryByText('ARS 85.000')).not.toBeInTheDocument()
  })

  test('an installment row shows its remaining-cuota count as a word', () => {
    renderList(commitments)

    // The "N left" caption is the load-bearing installment-tail signal (ADR-176).
    expect(screen.getByText(/Cuota — 9 left/i)).toBeInTheDocument()
    expect(screen.getByText('ARS 30.000')).toBeInTheDocument()
  })

  test('renders each line in its own currency and drops the tax line', () => {
    renderList([
      {
        source: 'subscription',
        label: 'Figma',
        amount: 12,
        currency: 'USD',
        arsFixed: false,
        months: ['2026-08'],
        remainingCount: null,
      },
      {
        source: 'tax',
        label: 'Monotributo',
        amount: 85_000,
        currency: 'ARS',
        arsFixed: true,
        months: ['2026-08'],
        remainingCount: null,
      },
    ])

    expect(screen.getByText('USD 12')).toBeInTheDocument()
    // The tax line is filtered out — it is shown on the Monotributo card (ADR-177).
    expect(screen.queryByText('ARS 85.000')).not.toBeInTheDocument()
    expect(screen.queryByText('Monotributo')).not.toBeInTheDocument()
  })

  test('omits an empty group and does not show its heading', () => {
    renderList([commitments[0]]) // only a subscription

    expect(screen.getByRole('list', { name: 'Subscriptions' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Taxes' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Installments' }),
    ).not.toBeInTheDocument()
  })

  test('no commitments degrades to a calm note', () => {
    renderList([])

    expect(screen.getByText(/No committed streams yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  test('a subscription row shows no remaining-count caption', () => {
    renderList([commitments[0]])

    const subs = screen.getByRole('list', { name: 'Subscriptions' })
    expect(within(subs).queryByText(/left/i)).not.toBeInTheDocument()
  })
})
