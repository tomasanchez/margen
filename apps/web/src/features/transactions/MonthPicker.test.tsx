/**
 * MonthPicker tests (ADR-040, ADR-019, ADR-037).
 *
 * The picker surfaces the named ranges — This month · Last 12 months · This
 * year · All time — at the TOP of the menu, above the specific-month list.
 * "This month" stores the current ViewingMonth; the other three store their
 * sentinel value. Each option is a keyboard-operable MenuItem flagged with a
 * trailing check (non-color cue) and `aria-checked`.
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { MonthPicker } from './MonthPicker'
import {
  ALL_MONTHS,
  LAST_12_MONTHS,
  THIS_YEAR,
  currentViewingMonth,
  type MonthSelection,
} from '../../components/months'

/** A few ISO dates so the specific-month list has options to render. */
const OCCURRED_ONS = ['2026-06-12', '2026-05-20', '2026-04-02'] as const

function renderPicker(
  value: MonthSelection,
  onChange: (next: MonthSelection) => void = () => {},
) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <MonthPicker value={value} onChange={onChange} occurredOns={OCCURRED_ONS} />
    </ThemeProvider>,
  )
}

describe('MonthPicker named ranges', () => {
  test('renders the four named ranges at the top of the menu', async () => {
    const user = userEvent.setup()
    renderPicker(ALL_MONTHS)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))

    expect(
      await screen.findByRole('menuitem', { name: /This month/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Last 12 months/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /This year/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /All time/ }),
    ).toBeInTheDocument()
  })

  test('selecting "Last 12 months" dispatches the LAST_12_MONTHS sentinel', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker(ALL_MONTHS, onChange)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))
    await user.click(
      await screen.findByRole('menuitem', { name: /Last 12 months/ }),
    )
    expect(onChange).toHaveBeenCalledWith(LAST_12_MONTHS)
  })

  test('selecting "This year" dispatches the THIS_YEAR sentinel', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker(ALL_MONTHS, onChange)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))
    await user.click(await screen.findByRole('menuitem', { name: /This year/ }))
    expect(onChange).toHaveBeenCalledWith(THIS_YEAR)
  })

  test('selecting "All time" dispatches the ALL_MONTHS sentinel', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker(LAST_12_MONTHS, onChange)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))
    await user.click(await screen.findByRole('menuitem', { name: /All time/ }))
    expect(onChange).toHaveBeenCalledWith(ALL_MONTHS)
  })

  test('"This month" dispatches the current ViewingMonth (a specific month)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker(ALL_MONTHS, onChange)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))
    await user.click(await screen.findByRole('menuitem', { name: /This month/ }))
    expect(onChange).toHaveBeenCalledWith(currentViewingMonth())
  })

  test('the active range is flagged with aria-checked', async () => {
    const user = userEvent.setup()
    renderPicker(THIS_YEAR)
    await user.click(screen.getByRole('button', { name: /^Month:/ }))
    const thisYear = await screen.findByRole('menuitem', { name: /This year/ })
    expect(thisYear).toHaveAttribute('aria-checked', 'true')
    const last12 = screen.getByRole('menuitem', { name: /Last 12 months/ })
    expect(last12).toHaveAttribute('aria-checked', 'false')
  })

  test('a range selection shows its name on the trigger', () => {
    renderPicker(LAST_12_MONTHS)
    expect(
      screen.getByRole('button', { name: 'Month: Last 12 months' }),
    ).toBeInTheDocument()
  })
})
