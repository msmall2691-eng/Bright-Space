/**
 * Regression: fast week-to-week navigation must not let a slow response for
 * the week the user just LEFT overwrite the week they navigated TO (audit
 * finding #6, July 2026 — "fast week-to-week navigation can render the
 * wrong week's jobs").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

vi.mock('../../api', () => ({
  get: vi.fn(),
  getCached: vi.fn(async () => []),
}))

import { get } from '../../api'
import { useScheduleData } from '../useScheduleData'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function weekPayload(tag) {
  return { jobs: [], properties: [], clients: [], visits: [{ id: tag }] }
}

describe('useScheduleData', () => {
  it('ignores a stale response for a week the user navigated away from', async () => {
    const resolvers = []
    get.mockImplementation((url) => new Promise((resolve) => { resolvers.push({ url, resolve }) }))

    const { rerender, result } = renderHook(
      ({ date }) => useScheduleData(date, 'week', { pollMs: 0 }),
      { initialProps: { date: new Date(2026, 0, 5) } } // early January
    )

    // Navigate to a week 5 months later before the first request resolves.
    rerender({ date: new Date(2026, 5, 1) })

    expect(resolvers.length).toBe(2)
    const [firstWeek, secondWeek] = resolvers

    // The CURRENT week (second) resolves first...
    await act(async () => {
      secondWeek.resolve(weekPayload('current-week'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.visits).toEqual([{ id: 'current-week' }])

    // ...then the stale first-week request finally lands. Must be dropped.
    await act(async () => {
      firstWeek.resolve(weekPayload('stale-week'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.visits).toEqual([{ id: 'current-week' }])
  })

  it('a normal single load (no race) still sets visits', async () => {
    get.mockImplementation(() => Promise.resolve(weekPayload('solo')))

    const { result } = renderHook(
      ({ date }) => useScheduleData(date, 'week', { pollMs: 0 }),
      { initialProps: { date: new Date(2026, 0, 5) } }
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.visits).toEqual([{ id: 'solo' }])
  })
})

// Pins the Codex follow-up on the July-2026 audit #5 fix: Schedule.jsx now
// calls useScheduleData() unconditionally (Rules of Hooks), including while
// rendering the ?tab=recurring / ?tab=availability sub-pages that never
// read visits/jobs. Without a way to opt out, that meant a hidden
// /api/schedule/week fetch plus its 45s poll running continuously in the
// background the whole time an operator sat on one of those tabs.
// `enabled` (default true) lets the caller skip both the fetch and the
// poll, and re-fetch immediately when flipped back on.
//
// Fake timers are scoped to this describe block only (nested beforeEach/
// afterEach) so they don't affect the real-Promise-timing race tests above.
describe('useScheduleData — enabled gate (Codex follow-up on audit #5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    get.mockResolvedValue({ visits: [], jobs: [], properties: [], clients: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips the fetch entirely when enabled is false', async () => {
    renderHook(() => useScheduleData(new Date(2026, 6, 12), 'week', { enabled: false }))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(get).not.toHaveBeenCalled()
  })

  it('never sets up the poll interval when enabled is false', async () => {
    renderHook(() => useScheduleData(new Date(2026, 6, 12), 'week', { enabled: false, pollMs: 1000 }))
    await act(async () => { await vi.runAllTimersAsync() })
    get.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches immediately once flipped from disabled to enabled', async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useScheduleData(new Date(2026, 6, 12), 'week', { enabled, pollMs: 1000 }),
      { initialProps: { enabled: false } }
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(get).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toMatch(/^\/api\/schedule\/week\?/)
  })

  it('still polls normally when enabled is true (default)', async () => {
    renderHook(() => useScheduleData(new Date(2026, 6, 12), 'week', { pollMs: 1000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(get).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(get).toHaveBeenCalledTimes(2)
  })
})

/**
 * Returning to a backgrounded tab refetches when the data has gone stale.
 *
 * Why this exists: the poll skips every tick while the tab is hidden, so
 * without a refetch on the way back in, returning to a backgrounded dashboard
 * showed up to a full interval of stale schedule. That made the interval a
 * tug-of-war — short enough to be fresh on return, or long enough not to burn
 * requests while you sit there. These pin the resolution, which is what lets
 * the Ops Board run a 3-minute interval instead of 45 seconds.
 */
describe('useScheduleData — refresh on returning to the tab', () => {
  let hidden = false
  const setHidden = (v) => { hidden = v }

  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    get.mockImplementation(async () => weekPayload('a'))
  })

  const show = async () => {
    setHidden(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  }

  it('refetches when the data is older than the poll interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await act(async () => {
        renderHook(() => useScheduleData(new Date(2026, 0, 5), 'week', { pollMs: 60000 }))
      })
      const afterLoad = get.mock.calls.length
      expect(afterLoad).toBeGreaterThan(0)

      setHidden(true)
      // Past the interval while hidden — the tick itself is a no-op.
      await act(async () => { vi.advanceTimersByTime(90000) })
      expect(get.mock.calls.length).toBe(afterLoad)

      await show()
      expect(get.mock.calls.length).toBeGreaterThan(afterLoad)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not refetch on a quick alt-tab, when the data is still fresh', async () => {
    await act(async () => {
      renderHook(() => useScheduleData(new Date(2026, 0, 5), 'week', { pollMs: 180000 }))
    })
    const afterLoad = get.mock.calls.length

    // Away and back inside the interval: the data on screen is still good, and
    // two round trips for one alt-tab is exactly the waste this guards.
    setHidden(true)
    await show()
    expect(get.mock.calls.length).toBe(afterLoad)
  })

  it('stays off entirely when polling is disabled', async () => {
    await act(async () => {
      renderHook(() => useScheduleData(new Date(2026, 0, 5), 'week', { pollMs: 0 }))
    })
    const afterLoad = get.mock.calls.length

    setHidden(true)
    await show()
    expect(get.mock.calls.length).toBe(afterLoad)
  })
})
