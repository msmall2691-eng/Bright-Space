/**
 * Regression: fast client-to-client navigation must not let a slow response
 * for the PREVIOUS client overwrite the state of the client the user is now
 * looking at (audit finding #6, July 2026 — "clicking client A then client B
 * quickly can show A's jobs/quotes/messages on B's page").
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn() }))

import { get } from '../../api'
import { useClientProfileData } from '../useClientProfileData'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useClientProfileData', () => {
  it('ignores a stale client-A profile response that resolves after client-B loaded', async () => {
    const resolvers = {}
    get.mockImplementation((url) => {
      const m = url.match(/\/api\/clients\/([^/]+)\/profile$/)
      if (m) {
        return new Promise((resolve) => { resolvers[m[1]] = resolve })
      }
      // Every parallel collection call (jobs/quotes/invoices/comms/etc.)
      // resolves immediately with an empty shape.
      return Promise.resolve([])
    })

    const { rerender, result } = renderHook(
      ({ id }) => useClientProfileData(id),
      { initialProps: { id: 'A' } }
    )

    // Navigate to client B before A's profile request resolves.
    rerender({ id: 'B' })

    // B (the current client) resolves first...
    await act(async () => {
      resolvers['B']({ id: 'B', name: 'Client B' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.client?.id).toBe('B')

    // ...then A's slow response finally lands. It must be dropped, not
    // overwrite B's state.
    await act(async () => {
      resolvers['A']({ id: 'A', name: 'Client A' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.client?.id).toBe('B')
  })

  it('a normal single load (no race) still sets client state', async () => {
    get.mockImplementation((url) => {
      if (/\/api\/clients\/\d+\/profile$/.test(url)) {
        return Promise.resolve({ id: 42, name: 'Solo Client' })
      }
      return Promise.resolve([])
    })

    const { result } = renderHook(() => useClientProfileData(42))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.client?.id).toBe(42)
  })
})
