/**
 * Regression: fast week-to-week navigation must not let a slow response for
 * the week the user just LEFT overwrite the week they navigated TO (audit
 * finding #6, July 2026 — "fast week-to-week navigation can render the
 * wrong week's jobs").
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
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
