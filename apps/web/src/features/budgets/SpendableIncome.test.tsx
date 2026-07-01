/**
 * Unit tests for <SpendableIncome> — the allocation hero's left column (ADR-139,
 * ADR-143, ADR-105).
 *
 * Drives the presentational column directly: committing the net income fires the
 * callback, the income-pressure readout renders the calm ratio copy, the
 * suggested-strategy hint appears, "↻ avg last 3 mo" pulls + seeds the
 * suggestion, and the folded-in household floor commits once opened.
 * English-pinned.
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { SpendableIncome, type SpendableIncomeProps } from './SpendableIncome'
import type { BudgetIncome } from '../../api/budgetsClient'

const INCOME: BudgetIncome = {
  month: '2026-06',
  amount: '900000.00',
  currency: 'ARS',
  source: 'manual',
  floor: { amount: '500000.00', source: 'computed' },
}

function renderColumn(props: Partial<SpendableIncomeProps> = {}) {
  const onCommitIncome = props.onCommitIncome ?? vi.fn()
  const onCurrencyChange = props.onCurrencyChange ?? vi.fn()
  const onCommitFloor = props.onCommitFloor ?? vi.fn()
  const onUseSuggested = props.onUseSuggested ?? vi.fn()
  render(
    <ColorModeProvider>
      <SpendableIncome
        income={props.income ?? INCOME}
        monthLabel={props.monthLabel ?? 'June 2026'}
        currency={props.currency ?? 'ARS'}
        pressure={props.pressure ?? null}
        suggestedStrategy={props.suggestedStrategy ?? null}
        saving={props.saving}
        justSaved={props.justSaved}
        suggestedBase={props.suggestedBase}
        suggestedBaseEmpty={props.suggestedBaseEmpty}
        suggestedSparse={props.suggestedSparse}
        suggestedMonths={props.suggestedMonths}
        onCommitIncome={onCommitIncome}
        onCurrencyChange={onCurrencyChange}
        onCommitFloor={onCommitFloor}
        onUseSuggested={onUseSuggested}
      />
    </ColorModeProvider>,
  )
  return { onCommitIncome, onCurrencyChange, onCommitFloor, onUseSuggested }
}

describe('SpendableIncome', () => {
  test('commits an edited net income on blur', async () => {
    const user = userEvent.setup()
    const { onCommitIncome } = renderColumn()
    const input = screen.getByRole('textbox', { name: 'Net income for June 2026' })
    await user.clear(input)
    await user.type(input, '1000000')
    await user.tab()
    expect(onCommitIncome).toHaveBeenCalledWith('1000000')
  })

  test('commits a manual floor on blur once the floor field is opened', async () => {
    const user = userEvent.setup()
    const { onCommitFloor } = renderColumn()
    // The floor is folded behind a quiet disclosure (the comp has no floor field).
    await user.click(
      screen.getByRole('button', { name: /Floor \(computed\)/ }),
    )
    const floor = screen.getByRole('textbox', { name: 'Household essentials floor' })
    await user.type(floor, '450000')
    await user.tab()
    expect(onCommitFloor).toHaveBeenCalledWith('450000')
  })

  test('renders the calm income-pressure readout from the ratio', () => {
    renderColumn({ pressure: 'Stable' })
    // 900000 / 500000 = 1.8× → the Stable copy with the ratio.
    expect(
      screen.getByText('Stable — income is 1.8× your essentials floor'),
    ).toBeInTheDocument()
  })

  test('renders the suggested-strategy hint with the profile label', () => {
    renderColumn({ suggestedStrategy: 'balanced' })
    expect(
      screen.getByText(/a Balanced profile looks like a good fit/),
    ).toBeInTheDocument()
  })

  test('the avg chip calls onUseSuggested', async () => {
    const user = userEvent.setup()
    const { onUseSuggested } = renderColumn({ suggestedBase: '850000.00' })
    await user.click(
      screen.getByRole('button', {
        name: 'Use the suggested net-income base of ARS 850.000',
      }),
    )
    expect(onUseSuggested).toHaveBeenCalledOnce()
  })

  test('shows the no-suggestion note when the lookup returned nothing', () => {
    renderColumn({ suggestedBaseEmpty: true })
    expect(
      screen.getByText(/needs at least one month of recorded income/),
    ).toBeInTheDocument()
  })

  test('labels a sparse estimate with the number of months backing it (ADR-153)', () => {
    renderColumn({
      suggestedBase: '1200.00',
      suggestedSparse: true,
      suggestedMonths: 3,
    })
    expect(
      screen.getByText('Estimate from 3 months of history'),
    ).toBeInTheDocument()
  })

  test('the currency selector drives the budget currency (ADR-156)', async () => {
    const user = userEvent.setup()
    // ARS is the current currency (selected); switching to USD fires the change
    // handler with the new currency — which the page sends on PUT /budget-income
    // and becomes the whole budget's currency.
    const { onCurrencyChange } = renderColumn({ currency: 'ARS' })
    const usd = screen.getByRole('button', { name: 'US dollars (USD)' })
    await user.click(usd)
    expect(onCurrencyChange).toHaveBeenCalledWith('USD')
  })

  test('re-selecting the current currency does not fire a change', async () => {
    const user = userEvent.setup()
    const { onCurrencyChange } = renderColumn({ currency: 'ARS' })
    await user.click(screen.getByRole('button', { name: 'Pesos (ARS)' }))
    expect(onCurrencyChange).not.toHaveBeenCalled()
  })

  test('shows the auto-save status: Saving… while in flight, Saved ✓ on success', () => {
    const { rerender } = renderColumnControlled({ saving: true })
    expect(screen.getByText('Saving…')).toBeInTheDocument()
    rerender({ saving: false, justSaved: true })
    expect(screen.getByText('Saved ✓')).toBeInTheDocument()
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument()
  })
})

/** Render the income column with re-render support for the save-status assertion. */
function renderColumnControlled(initial: Partial<SpendableIncomeProps>) {
  const props: SpendableIncomeProps = {
    income: INCOME,
    monthLabel: 'June 2026',
    currency: 'ARS',
    pressure: null,
    suggestedStrategy: null,
    onCommitIncome: vi.fn(),
    onCurrencyChange: vi.fn(),
    onCommitFloor: vi.fn(),
    onUseSuggested: vi.fn(),
    ...initial,
  }
  const { rerender } = render(
    <ColorModeProvider>
      <SpendableIncome {...props} />
    </ColorModeProvider>,
  )
  return {
    rerender: (next: Partial<SpendableIncomeProps>) =>
      rerender(
        <ColorModeProvider>
          <SpendableIncome {...props} {...next} />
        </ColorModeProvider>,
      ),
  }
}
