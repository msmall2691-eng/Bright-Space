/**
 * The cleaner roster is fetched ONCE on `?tab=availability`, not twice.
 *
 * `AvailabilityPanel` loaded the roster with a raw `get('/api/dispatch/
 * employees')`. A raw `get` neither reads nor writes `getCached`'s store, so
 * it can't be de-duplicated against anything — and on this tab there is
 * something to de-duplicate against: `Schedule` calls `useScheduleData`, which
 * calls `useEmployees()` UNCONDITIONALLY. Hooks can't be conditional, and the
 * `enabled: !tab` option gates only the week fetch, so the roster is already in
 * flight when the panel asks for it again.
 *
 * Two requests for the same rarely-changing lookup table, on one screen, is
 * the `brightbase-economy` audit item ("two components fetching the same
 * endpoint on one screen → lift the fetch or share it") on a page the owner
 * opens on a phone.
 *
 * It survived an earlier sweep because `useEmployees`' own docstring listed
 * `ScheduleTabs (AvailabilityPanel)` among the callers it had converted. It
 * hadn't been. Nobody re-checks a comment that says the work is done — the
 * same docstring also named a file that does not exist and one that was dead
 * code (both corrected in #1144).
 *
 * ## Why this counts `fetch` rather than mocking the api module
 *
 * The thing under test IS the de-duplication, and that lives inside
 * `getCached`. Mocking `api` would replace the mechanism with a stub and leave
 * the test asserting which function name the source calls — a source check
 * wearing a behaviour test's clothes. Stubbing `fetch` instead keeps the real
 * `getCached` (in-flight promise sharing plus a 2-minute memo) in the path, so
 * the number this asserts is the number of requests the browser actually makes.
 *
 * `getCached`'s store is module-level, so each test re-imports the modules
 * through a fresh registry; otherwise the second test would be served the
 * first test's memo and pass for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const ROSTER = '/api/dispatch/employees'

let fetchMock

/** How many requests actually went out for a URL. */
const callsFor = (needle) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(needle)).length

beforeEach(() => {
  // A fresh module registry per test, so getCached starts with an empty store.
  vi.resetModules()
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [],
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the availability tab does not double-fetch the roster', () => {
  it('serves both roster consumers on that screen with one request', async () => {
    const { AvailabilityPanel } = await import('../ScheduleTabs')
    const { useEmployees } = await import('../../../hooks/useEmployees')

    // Stands in for Schedule -> useScheduleData, which calls useEmployees()
    // unconditionally and so is already fetching the roster when the panel
    // mounts. Rendering all of Schedule would pull in its week fetch and a
    // dozen child trees; this is the part that matters.
    const SiblingConsumer = () => { useEmployees(); return null }

    render(<><SiblingConsumer /><AvailabilityPanel /></>)

    await waitFor(() => expect(callsFor(ROSTER)).toBeGreaterThan(0))
    // Let anything else the panel kicks off settle, so a second request can't
    // land after the assertion.
    await waitFor(() => expect(callsFor('/api/jobs/time-off')).toBeGreaterThan(0))

    expect(callsFor(ROSTER),
      'the roster went out more than once on one screen — a raw get() cannot '
      + 'share getCached\'s in-flight promise, so route the caller through '
      + 'useEmployees').toBe(1)
  })

  it('still shows a cleaner name from the shared roster', async () => {
    // The panel's own `empName` fallback was `Cleaner ${id}`; useEmployees'
    // is the same string, and it additionally indexes by userId. So this is
    // not just a request-count change — it must still put a NAME on the row.
    fetchMock.mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (String(url).includes(ROSTER)
        ? [{ id: 7, name: 'Dana' }]
        : [{ id: 1, cleaner_id: 7, start_date: '2026-11-02', end_date: '2026-11-04', reason: 'vacation' }]),
    }))

    const { AvailabilityPanel } = await import('../ScheduleTabs')
    const { container } = render(<AvailabilityPanel />)

    // Scoped to the entry list: the name is also an <option> in the "Cleaner"
    // select, so an unscoped query matches twice and says nothing about the row.
    await waitFor(() => expect(container.querySelector('ul')).toBeTruthy())
    const list = container.querySelector('ul')
    await waitFor(() => expect(list.textContent).toContain('Dana'))
    expect(list.textContent, 'fell back to the id, so the roster did not reach the row')
      .not.toContain('Cleaner 7')
  })

  it('waits for the roster before rendering a row, not just for the entries', async () => {
    // The old Promise.all held the list back until BOTH landed. Taking the
    // roster out of it and gating only on the time-off fetch lets a row
    // render as `Cleaner 7` and flip to `Dana` a moment later — a flicker on
    // exactly the slow connections this app runs on. So the panel folds the
    // hook's own loading flag into its skeleton, and that is what this pins.
    let releaseRoster
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes(ROSTER)) {
        await new Promise(r => { releaseRoster = r })
        return { ok: true, status: 200, headers: { get: () => null },
                 json: async () => [{ id: 7, name: 'Dana' }] }
      }
      return { ok: true, status: 200, headers: { get: () => null },
               json: async () => [{ id: 1, cleaner_id: 7, start_date: '2026-11-02', end_date: '2026-11-04' }] }
    })

    const { AvailabilityPanel } = await import('../ScheduleTabs')
    const { container } = render(<AvailabilityPanel />)

    // Entries have landed; the roster has not. Nothing may show an id yet.
    await waitFor(() => expect(callsFor(ROSTER)).toBe(1))
    await waitFor(() => expect(container.textContent).toContain('Loading'))
    expect(container.textContent, 'rendered a row before the roster landed')
      .not.toContain('Cleaner 7')

    releaseRoster()
    await waitFor(() => expect(container.querySelector('ul')?.textContent).toContain('Dana'))
  })
})
