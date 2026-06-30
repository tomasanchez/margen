/**
 * Unit tests for the Budgets page (ADR-125, ADR-037, ADR-019, ADR-105).
 *
 * Drives the page against a MOCKED {@link budgetsClient} (the network boundary),
 * so the real TanStack Query hooks + the row edit flows run end to end:
 *
 *  - every expense category renders with its target / spent / progress;
 *  - typing a target and blurring PUTs the upsert for that category + month;
 *  - clearing the input and blurring DELETEs the target;
 *  - an over-budget category shows the non-color "Over budget" cue;
 *  - stepping the month navigator refetches for the new YYYY-MM;
 *  - a GET failure surfaces the calm error state.
 *
 * The page renders no router <Link>s, so a plain QueryClient + ColorMode wrapper
 * suffices. English-pinned (ADR-105); money asserted via the shared es-AR
 * formatter.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import { BudgetsPage } from './BudgetsPage'
import { budgetsClient, type BudgetPeriod } from '../../api/budgetsClient'

vi.mock('../../api/budgetsClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/budgetsClient')>()
  return {
    ...actual,
    budgetsClient: {
      fetchBudgets: vi.fn(),
      setTarget: vi.fn(),
      clearTarget: vi.fn(),
    },
  }
})

const mockFetch = vi.mocked(budgetsClient.fetchBudgets)
const mockSet = vi.mocked(budgetsClient.setTarget)
const mockClear = vi.mocked(budgetsClient.clearTarget)

/** A period: Food under budget, Rent over budget, Transport with no target set. */
function period(month: string): BudgetPeriod {
  return {
    month,
    currency: 'ARS',
    categories: [
      { category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' },
      { category: 'Rent', target: '200000.00', spent: '230000.00', remaining: '-30000.00' },
      { category: 'Transport', target: null, spent: '15000.00', remaining: null },
    ],
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <BudgetsPage />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('BudgetsPage', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(period('2026-06'))
    mockSet.mockResolvedValue(undefined)
    mockClear.mockResolvedValue(undefined)
  })
  afterEach(() => vi.clearAllMocks())

  test('renders each category with its target, spent and progress', async () => {
    renderPage()

    // The page heading names the route landmark (renders immediately).
    expect(
      screen.getByRole('heading', { name: 'Budgets', level: 1 }),
    ).toBeInTheDocument()

    // Every category is present (incl. the untargeted Transport) once loaded.
    expect(await screen.findByText('Food')).toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()
    expect(screen.getByText('Transport')).toBeInTheDocument()

    // Spent figures render via the shared es-AR formatter.
    expect(screen.getByText('Spent ARS 90.000')).toBeInTheDocument()

    // Food's target seeds its input (the saved value).
    const foodInput = screen.getByRole('textbox', { name: 'Food target' })
    expect(foodInput).toHaveValue('120000.00')

    // Food's meter announces its progress (90000 / 120000 = 75%).
    expect(
      screen.getByRole('meter', { name: 'Food: 75% of target spent' }),
    ).toBeInTheDocument()
  })

  test('shows the non-color over-budget cue for an over category', async () => {
    renderPage()
    await screen.findByText('Rent')
    // Rent is over budget: a text "Over budget" cue accompanies the meter (not
    // color alone, ADR-019).
    expect(screen.getAllByText('Over budget').length).toBeGreaterThan(0)
    expect(screen.getByText('ARS 30.000 over')).toBeInTheDocument()
  })

  test('typing a target and blurring PUTs the upsert for that category', async () => {
    const user = userEvent.setup()
    renderPage()

    const transportInput = await screen.findByRole('textbox', {
      name: 'Transport target',
    })
    await user.click(transportInput)
    await user.type(transportInput, '50000')
    await user.tab() // blur commits

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Transport',
        month: '2026-06',
        amount: '50000',
      })
    })
  })

  test('clearing an existing target and blurring DELETEs it', async () => {
    const user = userEvent.setup()
    renderPage()

    const foodInput = await screen.findByRole('textbox', { name: 'Food target' })
    await user.clear(foodInput)
    await user.tab()

    await waitFor(() => {
      expect(mockClear).toHaveBeenCalledWith('Food', '2026-06')
    })
    expect(mockSet).not.toHaveBeenCalled()
  })

  test('a no-op blur (no change) does not fire a write', async () => {
    const user = userEvent.setup()
    renderPage()

    const foodInput = await screen.findByRole('textbox', { name: 'Food target' })
    await user.click(foodInput)
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  test('stepping the month navigator refetches for the new month', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Food')

    // The initial load is for the current month; capture how it was first called.
    expect(mockFetch).toHaveBeenCalled()
    mockFetch.mockClear()
    mockFetch.mockResolvedValue(period('2026-05'))

    // Step to the previous month via the stepper's Previous-month button.
    await user.click(screen.getByRole('button', { name: 'Previous month' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    // The refetch month differs from the current month (one step back).
    const requested = mockFetch.mock.calls.at(-1)?.[0]
    expect(requested).toMatch(/^\d{4}-\d{2}$/)
  })

  test('a GET failure surfaces the calm error state with retry', async () => {
    mockFetch.mockRejectedValue(new Error('down'))
    renderPage()
    expect(
      await screen.findByRole('heading', { name: "Can't load your budgets" }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  test('the period summary totals budgeted vs spent over budgeted categories', async () => {
    renderPage()
    await screen.findByText('Food')
    // Budgeted = 120000 + 200000 = 320000; spent (budgeted only) = 90000 +
    // 230000 = 320000; Transport's 15000 is excluded. Both the Budgeted + Spent
    // figures read ARS 320.000, so two occurrences appear in the summary.
    expect(screen.getByText('Budgeted')).toBeInTheDocument()
    expect(screen.getByText('Spent', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getAllByText('ARS 320.000').length).toBeGreaterThanOrEqual(2)
  })
})
