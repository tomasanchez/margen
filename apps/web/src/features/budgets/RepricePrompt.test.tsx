/**
 * Unit tests for <RepricePrompt> (ADR-137, ADR-141, ADR-105).
 *
 * The one-line nudge opens a preview modal seeded from the REM inflation
 * constant; confirming POSTs the reprice with the typed inflation %; nothing
 * fires until the user confirms (never auto-applies). English-pinned.
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { RepricePrompt, type RepricePromptProps } from './RepricePrompt'
import type { BudgetPeriod } from '../../api/budgetsClient'

const PRIOR: BudgetPeriod = {
  month: '2026-05',
  currency: 'ARS',
  savings: [],
  floor: null,
  suggestedStrategy: null,
  pressure: null,
  categories: [
    { category: 'Housing', target: '300000.00', spent: '0', remaining: null, isEssential: true },
    { category: 'Food', target: '100000.00', spent: '0', remaining: null, isEssential: true },
    { category: 'Transport', target: null, spent: '0', remaining: null, isEssential: false },
  ],
}

function renderPrompt(props: Partial<RepricePromptProps> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn()
  render(
    <ColorModeProvider>
      <RepricePrompt
        prior={props.prior ?? PRIOR}
        priorLabel={props.priorLabel ?? 'May 2026'}
        toMonth={props.toMonth ?? '2026-06'}
        toLabel={props.toLabel ?? 'June 2026'}
        currency={props.currency ?? 'ARS'}
        applying={props.applying}
        applyError={props.applyError}
        onConfirm={onConfirm}
      />
    </ColorModeProvider>,
  )
  return { onConfirm }
}

describe('RepricePrompt', () => {
  test('shows the rollover nudge naming both months', () => {
    renderPrompt()
    expect(
      screen.getByText(
        'A new month with no targets yet. Reprice May 2026 for June 2026?',
      ),
    ).toBeInTheDocument()
  })

  test('does not fire onConfirm before the user confirms (never auto-applies)', async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderPrompt()
    // Open the preview but do not confirm.
    await user.click(screen.getByRole('button', { name: 'Reprice for June 2026' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('previews repriced caps at the seeded inflation %', async () => {
    const user = userEvent.setup()
    renderPrompt()
    await user.click(screen.getByRole('button', { name: 'Reprice for June 2026' }))
    // Seeded 2% → Housing 300000 → 306000, sorted first (largest cap).
    expect(await screen.findByText('ARS 306.000')).toBeInTheDocument()
    expect(screen.getByText('ARS 102.000')).toBeInTheDocument()
  })

  test('confirming POSTs the reprice with the inflation % and step-ups', async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderPrompt()
    await user.click(screen.getByRole('button', { name: 'Reprice for June 2026' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Apply reprice' }))
    expect(onConfirm).toHaveBeenCalledWith(2, {})
  })
})
