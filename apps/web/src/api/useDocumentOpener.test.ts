/**
 * Unit tests for {@link useDocumentOpener} (ADR-037, ADR-073/081, ADR-092).
 *
 * The hook drives an "open this authed PDF" control: fetch the bytes, wrap them
 * in a short-lived object URL, open a new tab, then revoke the URL. These tests
 * assert the happy path (fetch → createObjectURL → window.open → scheduled
 * revoke), the calm loading flag, and the calm error path (a failed fetch sets a
 * friendly message, opens no tab, and creates no object URL). `window.open` and
 * the object-URL APIs are stubbed because jsdom does not implement them; the
 * revoke timer is asserted by running it directly (real timers keep `waitFor`
 * working).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDocumentOpener } from './useDocumentOpener'

describe('useDocumentOpener', () => {
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn(() => ({}) as Window))
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('fetches the blob, opens it in a new tab, and schedules a revoke', async () => {
    // Capture (but do not auto-run) the scheduled revoke so we can assert it
    // without waiting the real delay, and without breaking waitFor's own timers.
    const realSetTimeout = window.setTimeout.bind(window)
    const scheduled: Array<() => void> = []
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(((handler: TimerHandler, timeout?: number) => {
        // Only capture the long-lived revoke timer; let any short internal timers
        // (e.g. waitFor's polling) run normally.
        if (typeof handler === 'function' && timeout && timeout >= 1000) {
          scheduled.push(handler as () => void)
          return 0 as unknown as ReturnType<typeof setTimeout>
        }
        return realSetTimeout(handler, timeout) as unknown as ReturnType<
          typeof setTimeout
        >
      }) as typeof window.setTimeout)

    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const fetchBlob = vi.fn().mockResolvedValue(blob)
    const { result } = renderHook(() => useDocumentOpener(fetchBlob))

    act(() => result.current.open())

    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
    expect(window.open).toHaveBeenCalledWith(
      'blob:mock-url',
      '_blank',
      'noopener,noreferrer',
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()

    // The object URL is revoked on a timer so the tab can load the PDF first; the
    // sensitive bytes never linger as a persistent, shareable link (ADR-073/081).
    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    act(() => scheduled.forEach((fn) => fn()))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  test('a failed fetch surfaces a calm error and opens no tab', async () => {
    const fetchBlob = vi
      .fn()
      .mockRejectedValue(new Error('Your session expired.'))
    const { result } = renderHook(() => useDocumentOpener(fetchBlob))

    act(() => result.current.open())

    await waitFor(() =>
      expect(result.current.error).toBe('Your session expired.'),
    )
    expect(window.open).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)

    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  test('shows a pop-up-blocked hint when window.open is blocked', async () => {
    vi.stubGlobal('open', vi.fn(() => null))
    const fetchBlob = vi
      .fn()
      .mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }))
    const { result } = renderHook(() => useDocumentOpener(fetchBlob))

    act(() => result.current.open())

    await waitFor(() => expect(result.current.error).toMatch(/pop-ups/i))
  })
})
