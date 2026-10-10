/**
 * A mounted roster consumer picks up an invalidation, instead of holding the
 * copy it took at mount for as long as it lives.
 *
 * `invalidateCached` clears the module-level store, which fixes the NEXT
 * `getCached` call. It does nothing for a `useEmployees` that already resolved:
 * the hook copies the array into state and its effect has `[]` deps, so it
 * never asks again. Found in review on #1148.
 *
 * The path is ordinary, not a rare race. Crew-ID and name edits commit on
 * BLUR, and the click that blurs the field is usually the click that navigates
 * away:
 *
 *   1. click a nav link → the field blurs → `savePatch` starts
 *   2. the router navigates in the same tick → Schedule mounts →
 *      `useScheduleData` → `useEmployees` → the memo is STILL WARM, because
 *      the PATCH has not resolved → stale roster copied into state
 *   3. the PATCH resolves → `invalidateCached` runs (module-level, so it still
 *      runs even though the Crew page unmounted) → store cleared
 *   4. nothing refetches. Schedule shows the old name, or omits someone whose
 *      crew ID just changed, for its entire mounted lifetime.
 *
 * So invalidation has to reach live consumers, not only future calls — the
 * same shape as the in-flight bug the epoch guard fixes. Both are "something
 * else is already holding this value".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'

const ROSTER = '/api/dispatch/employees'

let fetchMock
let roster

beforeEach(() => {
  vi.resetModules()
  roster = [{ id: 7, name: 'Dana', cleaner_id: '12' }]
  fetchMock = vi.fn(async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => roster,
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useEmployees follows an invalidation', () => {
  it('refetches when the roster it is showing is invalidated', async () => {
    const { invalidateCached } = await import('../../api')
    const { useEmployees, ROSTER_CACHE_URL } = await import('../useEmployees')

    let seen
    const Consumer = () => {
      const { employees } = useEmployees()
      seen = employees
      return null
    }
    render(<Consumer />)
    await waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].name).toBe('Dana')

    // Someone renames them (or changes the crew ID) on the Crew page.
    roster = [{ id: 7, name: 'Dana Q', cleaner_id: '99' }]
    await act(async () => { invalidateCached(ROSTER_CACHE_URL) })

    await waitFor(() => expect(seen[0].name,
      'a consumer mounted before the write kept its copy for its whole life')
      .toBe('Dana Q'))
    expect(seen[0].cleaner_id).toBe('99')
  })

  it('does not refetch on an unrelated URL being invalidated', async () => {
    const { invalidateCached } = await import('../../api')
    const { useEmployees } = await import('../useEmployees')

    const Consumer = () => { useEmployees(); return null }
    render(<Consumer />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await act(async () => { invalidateCached('/api/comms/conversations/summary') })
    // Give any stray effect a chance to fire before asserting it did not.
    await new Promise(r => setTimeout(r, 10))
    expect(fetchMock, 'every consumer woke on an unrelated invalidation')
      .toHaveBeenCalledTimes(1)
  })

  // There was a third case here asserting that an unmounted consumer stops
  // listening, and it was worthless: it passed with the unsubscribe replaced by
  // a no-op. A leaked listener calls setRefreshKey on a dead component, React
  // silently drops that, and no refetch happens either way — so the assertion
  // could not fail. The leak is real (the subscriber Set grows for the life of
  // the page) but it is not observable from out here, and a test that passes
  // whatever the code does is worse than no test, because it reads as coverage.
  //
  // The unsubscribe is pinned where it IS observable — against the primitive,
  // with a spy, in __tests__/cacheInvalidation.test.js.
})
