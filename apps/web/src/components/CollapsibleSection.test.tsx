/**
 * Unit tests for the reusable {@link CollapsibleSection} (ADR-019).
 *
 * Drives the SectionCard-based collapsible disclosure end to end via its public
 * behavior (no internals): the header title is a real button with
 * `aria-expanded`; activating it collapses/expands the body; a header `action`
 * button (e.g. "Add") never toggles collapse; the collapsed state persists per
 * device via localStorage across a remount; and the default is EXPANDED.
 *
 * English-pinned (ADR-105). localStorage is reset between tests so each case
 * starts from the default (no stored preference).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsibleSection } from './CollapsibleSection'
import { sectionCollapsedStorageKey } from './useSectionCollapsed'

function renderSection(extra?: { onAdd?: () => void }) {
  return render(
    <CollapsibleSection
      storageKey="test-section"
      title="Debts"
      action={
        extra?.onAdd ? (
          <button type="button" onClick={extra.onAdd}>
            Add debt
          </button>
        ) : undefined
      }
    >
      <p>Section body content</p>
    </CollapsibleSection>,
  )
}

describe('CollapsibleSection', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  test('defaults to expanded: body visible, aria-expanded true', () => {
    renderSection()
    const toggle = screen.getByRole('button', { name: 'Collapse Debts' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Section body content')).toBeVisible()
  })

  test('the toggle points at the region it controls (aria-controls)', () => {
    renderSection()
    const toggle = screen.getByRole('button', { name: 'Collapse Debts' })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    const body = document.getElementById(controls as string)
    expect(body).not.toBeNull()
    expect(body).toHaveTextContent('Section body content')
  })

  test('activating the toggle collapses the body and flips aria-expanded', async () => {
    const user = userEvent.setup()
    renderSection()

    const toggle = screen.getByRole('button', { name: 'Collapse Debts' })
    await user.click(toggle)

    // The label reflects the next action; aria-expanded flips to false.
    const collapsed = screen.getByRole('button', { name: 'Expand Debts' })
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    // Focus stays on the toggle after activation (ADR-019).
    expect(collapsed).toHaveFocus()
    // The body is unmounted/hidden once the collapse transition settles.
    await waitFor(() => {
      expect(screen.queryByText('Section body content')).not.toBeInTheDocument()
    })
  })

  test('is keyboard operable (Enter / Space) and expands again', async () => {
    const user = userEvent.setup()
    renderSection()

    const toggle = screen.getByRole('button', { name: 'Collapse Debts' })
    toggle.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.queryByText('Section body content')).not.toBeInTheDocument()
    })

    await user.keyboard(' ')
    expect(
      screen.getByRole('button', { name: 'Collapse Debts' }),
    ).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(screen.getByText('Section body content')).toBeVisible()
    })
  })

  test('persists the collapsed state across a remount via localStorage', async () => {
    const user = userEvent.setup()
    const { unmount } = renderSection()

    await user.click(screen.getByRole('button', { name: 'Collapse Debts' }))
    await waitFor(() => {
      expect(screen.queryByText('Section body content')).not.toBeInTheDocument()
    })
    // The preference was written under the per-section key.
    expect(
      window.localStorage.getItem(sectionCollapsedStorageKey('test-section')),
    ).toBe('1')

    unmount()
    renderSection()

    // Remounted collapsed (state remembered per device).
    expect(
      screen.getByRole('button', { name: 'Expand Debts' }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Section body content')).not.toBeInTheDocument()
  })

  test('a header action button does NOT toggle collapse', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    renderSection({ onAdd })

    await user.click(screen.getByRole('button', { name: 'Add debt' }))

    // The action ran, but the section stayed expanded (no collapse).
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Collapse Debts' }),
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Section body content')).toBeVisible()
    // No collapsed preference was written.
    expect(
      window.localStorage.getItem(sectionCollapsedStorageKey('test-section')),
    ).toBeNull()
  })
})
