/**
 * Interaction tests for the bounded month navigator (ADR-041).
 *
 * The navigator is bounded to the current month and the previous six (7 months):
 *   - `›` (Next month) is DISABLED at the current month — no future months.
 *   - `‹` at the 6-months-ago floor does NOT step further; it invokes
 *     `onNavigateOlder` so the shell can redirect to Transactions.
 *   - The mobile compact picker lists EXACTLY the bounded window (current month
 *     down to the floor, newest first), plus an "Older months" affordance that
 *     triggers the same redirect.
 *
 * Bounds are computed from the real client clock via the same helpers the
 * component uses, so the assertions stay deterministic relative to runtime (no
 * fake timers, which deadlock against MUI's Menu transition + userEvent).
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../theme/colorMode'
import { MonthSwitcher } from './MonthSwitcher'
import {
  addMonths,
  boundedMonthsWindow,
  currentViewingMonth,
  formatViewingMonth,
  lowerBoundMonth,
  upperBoundMonth,
} from './months'

function renderSwitcher(ui: React.ReactElement) {
  return render(<ColorModeProvider>{ui}</ColorModeProvider>)
}

describe('Stepper bounds', () => {
  test('Next month is disabled at the current month (no future)', () => {
    renderSwitcher(<MonthSwitcher value={currentViewingMonth()} />)
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled()
  })

  test('Next month is enabled below the current month', () => {
    renderSwitcher(<MonthSwitcher value={addMonths(upperBoundMonth(), -1)} />)
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled()
  })

  test('pressing ‹ at the 6-months-ago floor calls onNavigateOlder, not onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onNavigateOlder = vi.fn()
    renderSwitcher(
      <MonthSwitcher
        value={lowerBoundMonth()}
        onChange={onChange}
        onNavigateOlder={onNavigateOlder}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Older months — search in Transactions',
      }),
    )

    expect(onNavigateOlder).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('pressing ‹ above the floor steps back one month', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    // One month above the floor — guaranteed to step normally.
    const aboveFloor = addMonths(lowerBoundMonth(), 1)
    renderSwitcher(<MonthSwitcher value={aboveFloor} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(onChange).toHaveBeenCalledWith(addMonths(aboveFloor, -1))
  })
})

describe('Compact picker bounded window', () => {
  test('lists exactly the bounded window (current month down to the floor)', async () => {
    const user = userEvent.setup()
    renderSwitcher(
      <MonthSwitcher variant="compact" value={currentViewingMonth()} />,
    )

    await user.click(screen.getByRole('button', { name: /Select month/ }))
    const menu = screen.getByRole('menu')

    const expected = boundedMonthsWindow().map(formatViewingMonth)
    // 7 months: the current month down to 6 months back, newest first.
    expect(expected).toHaveLength(7)
    for (const label of expected) {
      expect(within(menu).getByText(label)).toBeInTheDocument()
    }
    // No future month, no older-than-floor month.
    const future = formatViewingMonth(addMonths(upperBoundMonth(), 1))
    const older = formatViewingMonth(addMonths(lowerBoundMonth(), -1))
    expect(within(menu).queryByText(future)).not.toBeInTheDocument()
    expect(within(menu).queryByText(older)).not.toBeInTheDocument()
  })

  test('the "Older months" affordance triggers the redirect', async () => {
    const user = userEvent.setup()
    const onNavigateOlder = vi.fn()
    renderSwitcher(
      <MonthSwitcher
        variant="compact"
        value={currentViewingMonth()}
        onNavigateOlder={onNavigateOlder}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Select month/ }))
    await user.click(screen.getByRole('menuitem', { name: /Older months/ }))
    expect(onNavigateOlder).toHaveBeenCalledTimes(1)
  })
})
