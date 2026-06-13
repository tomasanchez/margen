/**
 * Interaction tests for the Add/Edit transaction flow (ADR-018, ADR-019).
 *
 * Drives the flow through its real seam: a tiny trigger calls openAdd(), the
 * AddTransactionProvider renders the shared AddEditForm inside its Dialog/Drawer,
 * and the tests assert the AC-critical toggles:
 *   - switching Expense <-> Invoice/income shows/hides the income-only
 *     "Counts toward Monotributo" control;
 *   - selecting USD reveals the FX context line (converted ARS + MEP rate) and
 *     its rate-edit affordance.
 *
 * Queries prefer roles/labels per ADR-019. No store mutation happens here (we
 * never submit), so no re-seed is needed.
 */

import { describe, expect, test } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { useAddTransaction } from './addContext'

/** A trigger that opens the Add flow; rendered under the AddTransactionProvider. */
function OpenAddTrigger() {
  const { openAdd } = useAddTransaction()
  return (
    <button type="button" onClick={() => openAdd()}>
      open add
    </button>
  )
}

/** Open the Add dialog and return the dialog element + a userEvent session. */
async function openAddDialog() {
  const user = userEvent.setup()
  renderWithProviders(<OpenAddTrigger />, { withAddProvider: true })

  await user.click(screen.getByRole('button', { name: 'open add' }))
  // The Dialog (desktop, jsdom's default width) is labelled by the form title.
  const dialog = await screen.findByRole('dialog')
  return { user, dialog }
}

describe('Add flow — type toggles required fields', () => {
  test('Expense hides the Monotributo control; switching to income shows it', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Opens on Expense by default (concept default).
    expect(
      form.getByRole('heading', { name: 'New expense' }),
    ).toBeInTheDocument()
    expect(
      form.queryByText('Counts toward Monotributo'),
    ).not.toBeInTheDocument()
    // The expense category picker is present for expenses.
    expect(form.getByText('Category')).toBeInTheDocument()

    // Switch to Invoice / income.
    await user.click(form.getByRole('button', { name: 'Invoice / income' }))

    expect(
      form.getByRole('heading', { name: 'New invoice · income' }),
    ).toBeInTheDocument()
    // The income-only Monotributo switch now appears.
    expect(form.getByText('Counts toward Monotributo')).toBeInTheDocument()
    // ...and the expense-only Category section is gone.
    expect(form.queryByText('Category')).not.toBeInTheDocument()

    // Switching back to Expense hides it again.
    await user.click(form.getByRole('button', { name: 'Expense' }))
    expect(
      form.queryByText('Counts toward Monotributo'),
    ).not.toBeInTheDocument()
  })
})

describe('Add flow — USD shows the FX context line', () => {
  test('entering an amount and choosing USD shows the converted ARS + MEP rate', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // No FX line while the (default) currency is ARS.
    expect(form.queryByText(/at MEP/)).not.toBeInTheDocument()

    // Enter an amount, then switch the currency toggle to USD.
    const amount = form.getByLabelText(/^Amount in /)
    await user.type(amount, '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // FX context line: 500 USD * MEP 1245 = ARS 622.500 (es-AR grouping).
    expect(
      await form.findByText('≈ ARS 622.500 at MEP 1.245'),
    ).toBeInTheDocument()

    // The rate-edit affordance is present and reveals the rate field.
    const editRate = form.getByRole('button', { name: /Edit rate/ })
    expect(editRate).toBeInTheDocument()
    await user.click(editRate)
    expect(
      form.getByLabelText('MEP rate (ARS per USD)'),
    ).toBeInTheDocument()
  })

  test('editing the MEP rate recomputes the converted ARS amount', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    const amount = form.getByLabelText(/^Amount in /)
    await user.type(amount, '100')
    await user.click(form.getByRole('button', { name: 'USD' }))
    expect(
      await form.findByText('≈ ARS 124.500 at MEP 1.245'),
    ).toBeInTheDocument()

    // Open the rate editor and override the MEP rate.
    await user.click(form.getByRole('button', { name: /Edit rate/ }))
    const rateField = form.getByLabelText('MEP rate (ARS per USD)')
    await user.clear(rateField)
    await user.type(rateField, '1000')

    // 100 USD * 1000 = ARS 100.000.
    expect(
      await form.findByText('≈ ARS 100.000 at MEP 1.000'),
    ).toBeInTheDocument()
  })
})
