/**
 * Unit tests for the shared {@link ResponsiveModal} (ADR-017, ADR-019).
 *
 * Verifies the two presentations and the accessibility contract:
 *
 *  - it renders its title + children, and labels the surface by the title;
 *  - the close button + Escape both route to `onClose`;
 *  - on desktop (md+) it is a centered MUI Dialog; on mobile (md down) it is a
 *    bottom-anchored MUI Drawer — both expose `role="dialog"` so AT treats them
 *    alike. The viewport is switched by mocking `useMediaQuery`.
 *  - when no `title` is passed (children own the header) it renders no header of
 *    its own and labels the surface by the caller-supplied `titleId`.
 *
 * English-pinned (ADR-105). Mounts under ThemeProvider so MUI resolves the theme.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../theme'
import { ResponsiveModal } from './ResponsiveModal'

// Control the desktop/mobile branch deterministically: ResponsiveModal calls
// useMediaQuery(theme.breakpoints.down('md')) — true === mobile (Drawer).
const { mediaQueryMock } = vi.hoisted(() => ({ mediaQueryMock: vi.fn() }))
vi.mock('@mui/material', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/material')>()
  return { ...actual, useMediaQuery: mediaQueryMock }
})

function renderModal(ui: React.ReactElement) {
  return render(<ThemeProvider theme={darkTheme}>{ui}</ThemeProvider>)
}

beforeEach(() => {
  // Default to desktop (not mobile) unless a test overrides it.
  mediaQueryMock.mockReturnValue(false)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ResponsiveModal', () => {
  test('renders the title and children, labelled by the title', () => {
    renderModal(
      <ResponsiveModal open onClose={vi.fn()} title="Edit account">
        <p>Body content</p>
      </ResponsiveModal>,
    )

    const dialog = screen.getByRole('dialog')
    expect(
      screen.getByRole('heading', { name: 'Edit account' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
    // The surface is labelled by its own heading.
    expect(dialog).toHaveAccessibleName('Edit account')
  })

  test('the close button calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderModal(
      <ResponsiveModal open onClose={onClose} title="Edit account">
        <p>Body</p>
      </ResponsiveModal>,
    )

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape calls onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderModal(
      <ResponsiveModal open onClose={onClose} title="Edit account">
        <p>Body</p>
      </ResponsiveModal>,
    )

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('desktop (md+) renders a centered Dialog', () => {
    mediaQueryMock.mockReturnValue(false)
    renderModal(
      <ResponsiveModal open onClose={vi.fn()} title="Desktop modal">
        <p>Body</p>
      </ResponsiveModal>,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.querySelector('.MuiDialog-root')).not.toBeNull()
    expect(document.querySelector('.MuiDrawer-root')).toBeNull()
  })

  test('mobile (md down) renders a bottom Drawer that is still a dialog', () => {
    mediaQueryMock.mockReturnValue(true)
    renderModal(
      <ResponsiveModal open onClose={vi.fn()} title="Mobile sheet">
        <p>Body</p>
      </ResponsiveModal>,
    )

    // The Drawer carries role="dialog" + aria-modal so AT treats it like the
    // desktop surface.
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Mobile sheet')
    expect(document.querySelector('.MuiDrawer-root')).not.toBeNull()
    expect(document.querySelector('.MuiDialog-root')).toBeNull()
  })

  test('without a title it renders no header and is labelled by titleId', () => {
    renderModal(
      <ResponsiveModal open onClose={vi.fn()} titleId="external-heading">
        <h2 id="external-heading">Form-owned heading</h2>
        <p>Body</p>
      </ResponsiveModal>,
    )

    // No close button is rendered by the modal (the children own the header).
    expect(
      screen.queryByRole('button', { name: 'Close' }),
    ).not.toBeInTheDocument()
    // The single heading is the one the children rendered.
    expect(
      screen.getByRole('heading', { name: 'Form-owned heading' }),
    ).toBeInTheDocument()
    // The surface is labelled by the externally-supplied heading id.
    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Form-owned heading',
    )
  })

  test('closed renders nothing', () => {
    renderModal(
      <ResponsiveModal open={false} onClose={vi.fn()} title="Hidden">
        <p>Body</p>
      </ResponsiveModal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
