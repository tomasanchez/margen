import { expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../theme'
import { Amount } from './Amount'

/**
 * <Amount> render checks (ADR-016, ADR-019).
 *
 * Verifies es-AR grouping + sign glyph in the visible text and that the
 * accessible label spells out sign + currency rather than relying on the glyph.
 */

function renderAmount(ui: React.ReactElement) {
  return render(<ThemeProvider theme={darkTheme}>{ui}</ThemeProvider>)
}

test('renders an income amount with + sign and an accessible label', () => {
  renderAmount(<Amount value={622500} type="income" />)

  expect(screen.getByText('+ARS 622.500')).toBeInTheDocument()
  expect(
    screen.getByLabelText('plus 622.500 Argentine pesos'),
  ).toBeInTheDocument()
})

test('renders a USD expense as the ARS-equivalent figure with an FX subline', () => {
  // The main figure is the ARS-equivalent (dashboard base currency); the USD
  // original lives in the FX subline (concept convention).
  renderAmount(
    <Amount value={39616} type="expense" fxUsd={32} fxRate={1238} />,
  )

  // The glyph string lives on its own inner span; match the exact node so the
  // sibling FX subline does not get folded into the matched text content.
  expect(
    screen.getByText('−ARS 39.616', { selector: 'span[aria-hidden]' }),
  ).toBeInTheDocument()
  expect(screen.getByText('USD 32 · MEP 1.238')).toBeInTheDocument()
  expect(
    screen.getByLabelText('minus 39.616 Argentine pesos'),
  ).toBeInTheDocument()
})
