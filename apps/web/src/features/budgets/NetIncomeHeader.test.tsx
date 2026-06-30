/**
 * Unit tests for <NetIncomeHeader> (ADR-139, ADR-143, ADR-105).
 *
 * Drives the presentational header directly: committing the net income / floor
 * fields fires the right callbacks, the income-pressure readout renders the calm
 * ratio copy, the suggested-strategy hint appears, and "use suggested base"
 * pulls + seeds the suggestion. English-pinned.
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { NetIncomeHeader, type NetIncomeHeaderProps } from './NetIncomeHeader'
import type { BudgetIncome } from '../../api/budgetsClient'

const INCOME: BudgetIncome = {
  month: '2026-06',
  amount: '900000.00',
  currency: 'ARS',
  source: 'manual',
  floor: { amount: '500000.00', source: 'computed' },
}

function renderHeader(props: Partial<NetIncomeHeaderProps> = {}) {
  const onCommitIncome = props.onCommitIncome ?? vi.fn()
  const onCommitFloor = props.onCommitFloor ?? vi.fn()
  const onUseSuggested = props.onUseSuggested ?? vi.fn()
  render(
    <ColorModeProvider>
      <NetIncomeHeader
        income={props.income ?? INCOME}
        monthLabel={props.monthLabel ?? 'June 2026'}
        currency={props.currency ?? 'ARS'}
        pressure={props.pressure ?? null}
        suggestedStrategy={props.suggestedStrategy ?? null}
        suggestedBase={props.suggestedBase}
        suggestedBaseEmpty={props.suggestedBaseEmpty}
        onCommitIncome={onCommitIncome}
        onCommitFloor={onCommitFloor}
        onUseSuggested={onUseSuggested}
      />
    </ColorModeProvider>,
  )
  return { onCommitIncome, onCommitFloor, onUseSuggested }
}

describe('NetIncomeHeader', () => {
  test('commits an edited net income on blur', async () => {
    const user = userEvent.setup()
    const { onCommitIncome } = renderHeader()
    const input = screen.getByRole('textbox', { name: 'Net income for June 2026' })
    await user.clear(input)
    await user.type(input, '1000000')
    await user.tab()
    expect(onCommitIncome).toHaveBeenCalledWith('1000000')
  })

  test('commits a manual floor on blur', async () => {
    const user = userEvent.setup()
    const { onCommitFloor } = renderHeader()
    const floor = screen.getByRole('textbox', { name: 'Household essentials floor' })
    await user.type(floor, '450000')
    await user.tab()
    expect(onCommitFloor).toHaveBeenCalledWith('450000')
  })

  test('renders the calm income-pressure readout from the ratio', () => {
    renderHeader({ pressure: 'Stable' })
    // 900000 / 500000 = 1.8× → the Stable copy with the ratio.
    expect(
      screen.getByText('Stable — income is 1.8× your essentials floor'),
    ).toBeInTheDocument()
  })

  test('renders the suggested-strategy hint with the profile label', () => {
    renderHeader({ suggestedStrategy: 'balanced' })
    expect(
      screen.getByText(/a Balanced profile looks like a good fit/),
    ).toBeInTheDocument()
  })

  test('the use-suggested-base button calls onUseSuggested', async () => {
    const user = userEvent.setup()
    const { onUseSuggested } = renderHeader({ suggestedBase: '850000.00' })
    await user.click(
      screen.getByRole('button', {
        name: 'Use the suggested net-income base of ARS 850.000',
      }),
    )
    expect(onUseSuggested).toHaveBeenCalledOnce()
  })

  test('shows the no-suggestion note when the lookup returned nothing', () => {
    renderHeader({ suggestedBaseEmpty: true })
    expect(
      screen.getByText(/needs at least 12 months of income history/),
    ).toBeInTheDocument()
  })
})
