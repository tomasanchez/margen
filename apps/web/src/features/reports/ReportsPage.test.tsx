/**
 * Unit tests for the Reports page currency wiring (ADR-156, ADR-163).
 *
 * The one behaviour under test here is the BUG-1 fix: Budget vs Actual must read
 * the budgets period in the INCOME's currency (ADR-156) — never the ARS default,
 * never a live-rate display conversion — so the target and spent figures land in
 * the same currency and reconcile with the Budgets page for the same month.
 *
 * We spy on `useBudgets` (from `../budgets/queries`) to assert the currency the
 * page threads into it, driving the derivation off a mocked `useBudgetIncome`
 * plus the display-currency context (the two inputs the Budgets page uses). The
 * other panels' queries are stubbed to inert pending states so the page renders
 * without hitting the network. English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import {
  DisplayCurrencyContext,
  DEFAULT_DISPLAY_CURRENCY_VALUE,
  type DisplayCurrencyValue,
} from '../settings/displayCurrencyContext'
import { ReportsPage } from './ReportsPage'
import type { BudgetIncome } from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

// Spy on the budgets hooks: `useBudgets` records the (month, currency) it is
// called with; `useBudgetIncome` supplies the income whose currency the page
// must derive the budget currency from (ADR-156). Both return inert results so
// the Budget vs Actual card shows its calm loading skeleton.
const useBudgetsSpy = vi.fn()
let incomeData: BudgetIncome | undefined

vi.mock('../budgets/queries', () => ({
  useBudgets: (month: string, currency: Currency = 'ARS') => {
    useBudgetsSpy(month, currency)
    return { data: undefined, isPending: true, isError: false, refetch: vi.fn() }
  },
  useBudgetIncome: () => ({ data: incomeData, isPending: false }),
  usePreferredRate: () => ({ data: null, isPending: false }),
}))

// The other panels' data sources are irrelevant to this test — stub them to
// inert pending states so the page renders its calm skeletons (ADR-037).
vi.mock('../home/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../home/queries')>()
  return {
    ...actual,
    useSummary: () => ({ data: undefined, isPending: true, isError: false, refetch: vi.fn() }),
  }
})

vi.mock('./queries', () => ({
  useNetWorthHistory: () => ({ data: undefined, isPending: true, isError: false, refetch: vi.fn() }),
}))

vi.mock('../settings/queries', () => ({
  useSettings: () => ({ data: undefined, isPending: false }),
}))

function income(currency: Currency): BudgetIncome {
  return { month: '2026-06', amount: null, currency, source: 'manual', floor: null }
}

function renderPage(display?: Partial<DisplayCurrencyValue>) {
  const value: DisplayCurrencyValue = {
    ...DEFAULT_DISPLAY_CURRENCY_VALUE,
    ...display,
  }
  return render(
    <ThemeProvider theme={darkTheme}>
      <DisplayCurrencyContext.Provider value={value}>
        <ReportsPage />
      </DisplayCurrencyContext.Provider>
    </ThemeProvider>,
  )
}

describe('ReportsPage — budget currency wiring (ADR-156)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    useBudgetsSpy.mockClear()
    incomeData = undefined
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('requests budgets in the INCOME currency, not the ARS default (BUG-1)', () => {
    incomeData = income('USD')
    renderPage({ preferredCurrency: 'ARS' })
    // The budget follows the income (USD), NOT the ARS default and NOT the
    // preferred display currency (ARS here) — proving the fix threads the income
    // currency through, so target and spent land in the same denomination.
    expect(useBudgetsSpy).toHaveBeenCalledWith('2026-06', 'USD')
  })

  test('falls back to the preferred display currency until an income is set', () => {
    incomeData = undefined
    renderPage({ preferredCurrency: 'USD' })
    // No income yet → mirror the Budgets page fallback to the preferred display
    // currency (a convenience), not the hardcoded ARS default.
    expect(useBudgetsSpy).toHaveBeenCalledWith('2026-06', 'USD')
  })

  test('never defaults to ARS when the income is ARS but preferred is USD', () => {
    incomeData = income('ARS')
    renderPage({ preferredCurrency: 'USD' })
    // The income wins over the display preference (ADR-156: budget follows income).
    expect(useBudgetsSpy).toHaveBeenCalledWith('2026-06', 'ARS')
    expect(screen.getByRole('heading', { name: /reports/i, level: 1 })).toBeInTheDocument()
  })
})
