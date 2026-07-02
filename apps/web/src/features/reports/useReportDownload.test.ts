/**
 * Unit tests for {@link useReportDownload} (ADR-165, ADR-037).
 *
 * The hook drives an authed CSV download: fetch the bytes, wrap them in an object
 * URL, click a hidden `<a download>`, then revoke the URL. These tests assert the
 * happy path (fetch → createObjectURL → anchor click with the filename → revoke),
 * the calm loading flag, and the calm error path (a failed fetch sets a friendly
 * message and creates no object URL). The object-URL APIs are stubbed because
 * jsdom does not implement them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useReportDownload } from './useReportDownload'

describe('useReportDownload', () => {
  beforeEach(() => {
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

  test('fetches the blob, clicks a download anchor with the filename, and revokes', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    const blob = new Blob(['id,name\n1,Rent'], { type: 'text/csv' })
    const fetchBlob = vi.fn().mockResolvedValue(blob)
    const { result } = renderHook(() => useReportDownload())

    act(() => result.current.download(fetchBlob, 'margen-transactions-all-all.csv'))

    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
    expect(clickSpy).toHaveBeenCalledTimes(1)

    // The anchor carried the object URL + the requested filename.
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('margen-transactions-all-all.csv')
    expect(anchor.getAttribute('href')).toBe('blob:mock-url')

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    // A saved file needs no lingering URL — it's revoked immediately (ADR-165).
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  test('a failed fetch surfaces a calm error and creates no object URL', async () => {
    const fetchBlob = vi.fn().mockRejectedValue(new Error('Your session expired.'))
    const { result } = renderHook(() => useReportDownload())

    act(() => result.current.download(fetchBlob, 'x.csv'))

    await waitFor(() =>
      expect(result.current.error).toBe('Your session expired.'),
    )
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)

    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })
})
