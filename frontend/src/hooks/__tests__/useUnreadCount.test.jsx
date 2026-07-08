/**
 * Regression: default poll interval is 2 min, not 30s.
 *
 * The old 30s default hit /api/comms/conversations/summary twice a minute
 * per client — a heartbeat that measurably chipped away at the single
 * uvicorn worker's 502 headroom (see the 502 root-cause spec). This test
 * pins the fix so a future refactor can't quietly turn the dial back up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

vi.mock('../../api', () => ({
  getCached: vi.fn(async () => ({ unread: 0, unread_messages: 0 })),
}))

import { useUnreadCount } from '../useUnreadCount'
import { getCached } from '../../api'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('useUnreadCount', () => {
  it('defaults the poll interval to 2 min (120000ms)', async () => {
    renderHook(() => useUnreadCount())
    // First tick fires immediately.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getCached).toHaveBeenCalledTimes(1)

    // 60s in: no additional poll (would have fired under the old 30s default).
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getCached).toHaveBeenCalledTimes(1)

    // 120s in: exactly one more poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getCached).toHaveBeenCalledTimes(2)
  })

  it('respects an explicit intervalMs override', async () => {
    renderHook(() => useUnreadCount({ intervalMs: 60_000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(getCached).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getCached).toHaveBeenCalledTimes(2)
  })
})
