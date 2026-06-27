/**
 * Unit tests for the Home net-worth card (ADR-122/123/127/133).
 *
 * The card renders standalone, fed a {@link NetWorth} read model directly — the
 * `useNetWorth` query + client adapter are covered separately
 * (accountsClient.test). Here we assert the presentation: the total in the
 * display currency, the per-account breakdown (native balance + converted line
 * when the account is in another currency), the ADR-133 DEGRADE case
 * (balanceConverted === balance → no second line, calm note shown), the empty
 * state, and the loading skeleton. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../test/renderWithProviders'
import { NetWorthCard } from './NetWorthCard'
import type { NetWorth } from '../../api/accountsClient'

/** Mixed-currency net worth with a real USD→ARS conversion applied. */
const CONVERTED: NetWorth = {
  total: '1050000.00',
  currency: 'ARS',
  accounts: [
    {
      id: 'a1',
      name: 'Galicia ARS',
      currency: 'ARS',
      balance: '150000.00',
      balanceConverted: '150000.00',
    },
    {
      id: 'a2',
      name: 'Deel USD',
      currency: 'USD',
      balance: '720.00',
      balanceConverted: '900000.00',
    },
  ],
}

describe('NetWorthCard', () => {
  test('renders the total in the display currency and the per-account breakdown', () => {
    renderWithProviders(<NetWorthCard netWorth={CONVERTED} loading={false} />)

    // Total in the display currency (ARS, es-AR grouping → 1.050.000).
    expect(screen.getByText('ARS 1.050.000')).toBeInTheDocument()

    // Each account name + native balance is shown.
    expect(screen.getByText('Galicia ARS')).toBeInTheDocument()
    expect(screen.getByText('Deel USD')).toBeInTheDocument()
    expect(screen.getByText('USD 720')).toBeInTheDocument()

    // The USD account shows its converted ARS value as a secondary line.
    expect(screen.getByText('≈ ARS 900.000')).toBeInTheDocument()
  })

  test('degrade case (ADR-133): equal balances render no converted line + a calm note', () => {
    const degraded: NetWorth = {
      total: '720.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a2',
          name: 'Deel USD',
          currency: 'USD',
          balance: '720.00',
          balanceConverted: '720.00',
        },
      ],
    }
    renderWithProviders(<NetWorthCard netWorth={degraded} loading={false} />)

    // Native balance shown; no "≈" converted line (conversion was skipped).
    expect(screen.getByText('USD 720')).toBeInTheDocument()
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()

    // The calm degrade note explains the native-summed total.
    expect(
      screen.getByText(/Totalled in each account's own currency/i),
    ).toBeInTheDocument()
  })

  test('does not render a converted line for an account already in display currency', () => {
    const arsOnly: NetWorth = {
      total: '150000.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a1',
          name: 'Galicia ARS',
          currency: 'ARS',
          balance: '150000.00',
          balanceConverted: '150000.00',
        },
      ],
    }
    renderWithProviders(<NetWorthCard netWorth={arsOnly} loading={false} />)
    // The total and the single ARS row both read "ARS 150.000".
    expect(screen.getAllByText('ARS 150.000')).toHaveLength(2)
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
    // Not a cross-currency degrade — no native-sum note for an all-ARS portfolio.
    expect(
      screen.queryByText(/Totalled in each account's own currency/i),
    ).not.toBeInTheDocument()
  })

  test('shows the empty state when there are no accounts', () => {
    const empty: NetWorth = { total: '0.00', currency: 'ARS', accounts: [] }
    renderWithProviders(<NetWorthCard netWorth={empty} loading={false} />)
    expect(
      screen.getByText('Add an account to see your net worth here.'),
    ).toBeInTheDocument()
  })

  test('shows a loading skeleton while pending', () => {
    const { container } = renderWithProviders(
      <NetWorthCard netWorth={undefined} loading />,
    )
    expect(container.querySelector('.MuiSkeleton-root')).toBeInTheDocument()
  })

  test('shows a calm error state when the query errored', () => {
    renderWithProviders(
      <NetWorthCard netWorth={undefined} loading={false} isError />,
    )
    expect(screen.getByText('Net worth unavailable')).toBeInTheDocument()
  })
})
