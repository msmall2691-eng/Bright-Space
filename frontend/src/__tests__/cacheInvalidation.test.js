/**
 * A write that changes a cached lookup table drops the cached copy.
 *
 * `getCached` memoises a response for `ttlMs` and had no way to drop it. For
 * the two 5-second URLs that was invisible. For the roster it was not:
 * `useEmployees` caches `/api/dispatch/employees` for TWO MINUTES, on the
 * reasoning that the roster changes rarely — which is true right up to the
 * moment it changes.
 *
 * The workflow that breaks: add a cleaner on the Crew page, then go assign
 * them to a job. `POST /api/crew` succeeds, the Crew page updates its own rows
 * (it reads `/api/crew/roster`, a different endpoint), and the assign
 * drop-downs — JobCreateModal, JobEditModal, CalendarView, useScheduleData,
 * AvailabilityPanel — keep serving the memo. The new cleaner is missing for up
 * to two minutes, with nothing on screen explaining why.
 *
 * ## The in-flight case, which is the one worth being careful about
 *
 * Dropping the memo is not enough on its own. A request that started BEFORE
 * the write is still in flight when the write lands, and its `.then` would
 * write pre-write data back into the store afterwards — re-caching exactly the
 * stale value we just invalidated, for another full TTL. Callers already
 * awaiting that promise get the old list too.
 *
 * So invalidation bumps a per-URL epoch, a response only populates the store
 * if the epoch it started under is still current, and the in-flight entry is
 * dropped so the next caller starts a fresh request rather than joining the
 * doomed one. The third case below is that race, and it fails against a
 * `delete`-only implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ROSTER = '/api/dispatch/employees'

let fetchMock
let bodies          // url -> what the next response for it should be

const rosterCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(ROSTER)).length

/** A fetch stub that serves whatever `bodies` currently says. */
function stubFetch() {
  fetchMock = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      for (const [frag, value] of bodies) if (String(url).includes(frag)) return value
      return []
    },
  }))
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  // getCached's store is module-level, so every case needs a fresh registry or
  // it inherits the previous one's memo and passes for the wrong reason.
  vi.resetModules()
  bodies = new Map([[ROSTER, [{ id: 1, name: 'Dana' }]]])
  stubFetch()
})

afterEach(() => { vi.unstubAllGlobals() })

describe('adding a cleaner invalidates the cached roster', () => {
  it('serves the memo while nothing has changed', async () => {
    // The caching itself must keep working — this is the half that must NOT
    // regress when invalidation is added.
    const { getCached } = await import('../api')
    await getCached(ROSTER, 120000)
    await getCached(ROSTER, 120000)
    expect(rosterCalls()).toBe(1)
  })

  it('refetches after a write that changes the roster', async () => {
    const { getCached, post, invalidateCached } = await import('../api')

    const before = await getCached(ROSTER, 120000)
    expect(before.map(e => e.name)).toEqual(['Dana'])

    // Add a cleaner. The server now has two.
    bodies.set(ROSTER, [{ id: 1, name: 'Dana' }, { id: 2, name: 'Sam' }])
    await post('/api/crew', { full_name: 'Sam', email: 's@x.com' })
    invalidateCached(ROSTER)

    const after = await getCached(ROSTER, 120000)
    expect(rosterCalls(), 'the roster was served from the memo after a write that changed it')
      .toBe(2)
    expect(after.map(e => e.name),
      'the drop-downs would still be missing the new cleaner').toEqual(['Dana', 'Sam'])
  })

  it('does not let a request already in flight re-cache the stale list', async () => {
    const { getCached, invalidateCached } = await import('../api')

    // A read starts, and is still open when the write lands.
    let release
    fetchMock.mockImplementationOnce(async () => {
      await new Promise(r => { release = r })
      return { ok: true, status: 200, headers: { get: () => null },
               json: async () => [{ id: 1, name: 'Dana' }] }
    })
    const open = getCached(ROSTER, 120000)
    await new Promise(r => setTimeout(r, 0))

    bodies.set(ROSTER, [{ id: 1, name: 'Dana' }, { id: 2, name: 'Sam' }])
    invalidateCached(ROSTER)

    // The in-flight response resolves AFTER the invalidation. It must not
    // repopulate the store — otherwise the stale list is cached again, for a
    // fresh two minutes.
    release()
    await open

    const after = await getCached(ROSTER, 120000)
    expect(after.map(e => e.name),
      'a response that started before the write repopulated the cache after it')
      .toEqual(['Dana', 'Sam'])
  })
})
