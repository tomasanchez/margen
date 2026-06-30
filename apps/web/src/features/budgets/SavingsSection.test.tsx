/**
 * Unit tests for <SavingsSection> (ADR-138, ADR-105).
 *
 * Picking a profile fires onApply; savings rows render with their bucket label,
 * %, and amount; the floor-breach warning renders the calm "consider
 * Conservative" copy with the gap; and without an income base the section shows
 * the needs-income prompt. English-pinned.
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { SavingsSection, type SavingsSectionProps } from './SavingsSection'
import type { SavingLine } from '../../api/budgetsClient'

const SAVINGS: SavingLine[] = [
  { bucket: 'EmergencyFund', percent: 7, amount: '63000.00' },
  { bucket: 'FxHedge', percent: 3, amount: '27000.00' },
]

function renderSection(props: Partial<SavingsSectionProps> = {}) {
  const onApply = props.onApply ?? vi.fn()
  render(
    <ColorModeProvider>
      <SavingsSection
        savings={props.savings ?? SAVINGS}
        hasIncome={props.hasIncome ?? true}
        currency={props.currency ?? 'ARS'}
        selectedProfile={props.selectedProfile ?? null}
        applyingProfile={props.applyingProfile}
        applyError={props.applyError}
        floorBreached={props.floorBreached}
        floorGap={props.floorGap}
        onApply={onApply}
      />
    </ColorModeProvider>,
  )
  return { onApply }
}

describe('SavingsSection', () => {
  test('prompts for income when none is set', () => {
    renderSection({ hasIncome: false })
    expect(
      screen.getByText('Set your net income above to apply a saving profile.'),
    ).toBeInTheDocument()
  })

  test('picking a profile fires onApply with that profile', async () => {
    const user = userEvent.setup()
    const { onApply } = renderSection({ savings: [] })
    await user.click(screen.getByRole('button', { name: /Aggressive/ }))
    expect(onApply).toHaveBeenCalledWith('aggressive')
  })

  test('renders each saving row with its localized bucket label, % and amount', () => {
    renderSection()
    expect(screen.getByText('Emergency fund')).toBeInTheDocument()
    expect(screen.getByText('USD / FX hedge')).toBeInTheDocument()
    expect(screen.getByText('7% of net income')).toBeInTheDocument()
    expect(screen.getByText('ARS 63.000')).toBeInTheDocument()
  })

  test('shows the calm floor-breach warning with the gap', () => {
    renderSection({ floorBreached: true, floorGap: '40000.00' })
    expect(
      screen.getByText(
        'This preset leaves essentials below your floor by ARS 40.000 — consider Conservative.',
      ),
    ).toBeInTheDocument()
  })

  test('surfaces a calm apply-error hint', () => {
    renderSection({ applyError: true })
    expect(
      screen.getByText("Couldn't apply that profile — try again."),
    ).toBeInTheDocument()
  })
})
