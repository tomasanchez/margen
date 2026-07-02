/**
 * Render tests for {@link CommitmentsList} (ADR-176, ADR-177).
 *
 * The upcoming-commitments / installments-tail view: the committed streams grouped
 * by source (subscriptions, taxes, installments). Asserts each group heading
 * appears for a non-empty group, an installment row shows its remaining-cuota count
 * (the load-bearing "N left" signal, never colour), amounts render in each line's
 * OWN currency (the tax line stays ARS even alongside USD lines, ADR-177), an empty
 * group is omitted, and no commitments at all degrades to a calm note.
 * English-pinned (ADR-105).
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
    months: ['2026-08', '2026-09'],
    remainingCount: null,
  },
  {
    source: 'tax',
    label: 'Monotributo',
    amount: 85_000,
    currency: 'ARS',
    months: ['2026-08', '2026-09'],
    remainingCount: null,
  },
  {
    source: 'installment',
    label: 'Samsung TV',
    amount: 30_000,
    currency: 'ARS',
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
    expect(screen.getByRole('list', { name: 'Taxes' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Installments' })).toBeInTheDocument()
    expect(screen.getByText('Netflix')).toBeInTheDocument()
    expect(screen.getByText('Monotributo')).toBeInTheDocument()
  })

  test('an installment row shows its remaining-cuota count as a word', () => {
    renderList(commitments)

    // The "N left" caption is the load-bearing installment-tail signal (ADR-176).
    expect(screen.getByText(/Cuota — 9 left/i)).toBeInTheDocument()
    expect(screen.getByText('ARS 30.000')).toBeInTheDocument()
  })

  test('renders each line in its own currency (tax stays ARS beside USD)', () => {
    renderList([
      {
        source: 'subscription',
        label: 'Figma',
        amount: 12,
        currency: 'USD',
        months: ['2026-08'],
        remainingCount: null,
      },
      {
        source: 'tax',
        label: 'Monotributo',
        amount: 85_000,
        currency: 'ARS',
        months: ['2026-08'],
        remainingCount: null,
      },
    ])

    expect(screen.getByText('USD 12')).toBeInTheDocument()
    // The tax line is AFIP-ARS and never re-denominated (ADR-177).
    expect(screen.getByText('ARS 85.000')).toBeInTheDocument()
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
