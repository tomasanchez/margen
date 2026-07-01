/**
 * Render checks for Home's Recent activity list — specifically the row
 * attribution wiring (ADR-136 extension). Each row resolves its institution from
 * the loaded accounts (`accountId → institutionName`), so a linked Mercado-Pago
 * row shows "Mercado Pago"; a row with neither a resolvable account nor a real
 * bank shows just its category — never a fabricated "Transfer".
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { RecentActivity } from './RecentActivity'
import type { Account, Transaction } from '../../mock/types'

// The "View all →" link needs no real router for these assertions.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }))
vi.mock('../../api/accountsClient', () => ({
  accountsClient: { list: listMock },
}))

const ACCOUNTS: Account[] = [
  {
    id: 'acc-mp',
    institutionId: 'inst-mp',
    institutionName: 'Mercado Pago',
    currency: 'ARS',
    type: 'wallet',
    openingBalance: '0',
  },
]

const linkedRow: Transaction = {
  id: 'tx-1',
  occurredOn: '2026-07-01',
  dispDate: 'Jul 01',
  month: 'July',
  name: 'Freelance income',
  category: 'Income',
  bank: '' as Transaction['bank'],
  accountId: 'acc-mp',
  currency: 'ARS',
  type: 'income',
  kind: 'income',
  amountNum: 150000,
}

const unlinkedRow: Transaction = {
  id: 'tx-2',
  occurredOn: '2026-07-01',
  dispDate: 'Jul 01',
  month: 'July',
  name: 'Coffee',
  category: 'Food',
  bank: '' as Transaction['bank'],
  currency: 'ARS',
  type: 'expense',
  kind: 'expense',
  amountNum: 3200,
}

function renderRecent(transactions: Transaction[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={darkTheme}>
        <RecentActivity transactions={transactions} />
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  listMock.mockResolvedValue(ACCOUNTS)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RecentActivity attribution wiring', () => {
  test('a linked row resolves its institution ("Mercado Pago") from useAccounts', async () => {
    renderRecent([linkedRow])
    // The subline reads "Income · Mercado Pago" once accounts load.
    expect(await screen.findByText(/Mercado Pago/)).toBeInTheDocument()
    // And it is never the fabricated legacy tag.
    expect(screen.queryByText(/Transfer/)).not.toBeInTheDocument()
  })

  test('a row with no resolvable account + no bank shows just the category (no "Transfer")', async () => {
    renderRecent([unlinkedRow])
    expect(await screen.findByText('Food')).toBeInTheDocument()
    expect(screen.queryByText(/Transfer/)).not.toBeInTheDocument()
    expect(screen.queryByText('Food · ')).not.toBeInTheDocument()
  })
})
