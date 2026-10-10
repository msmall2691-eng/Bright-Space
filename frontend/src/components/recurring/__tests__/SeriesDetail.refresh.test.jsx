/**
 * `SeriesDetail`'s background refresh — the two ways it can go wrong.
 *
 * The refresh exists because the list can change a series out from under an
 * open detail view (pause a row, walk into the series, hit the Undo toast).
 * It is deliberately SILENT — it skips the `loading` flag, because the
 * component returns a skeleton while loading and that unmounts whatever modal
 * is open along with everything typed into it.
 *
 * Both cases here are consequences of adding that path, and both were found by
 * review rather than by me (codex P2s on #1161):
 *
 *  1. **A failed silent refresh took the screen down anyway.** The shared
 *     catch set the page-level `error`, which drives a full-page error branch
 *     — so a flaky network during a background refresh destroyed exactly the
 *     in-progress input the silent path was added to protect. Same loss, other
 *     door.
 *
 *  2. **Two loads in flight, no ordering.** The mount fetch and a refresh
 *     landing on top of it both wrote `schedule`, so a slow pre-Undo response
 *     could resolve last and put the stale snapshot back — leaving the detail
 *     showing exactly what the refresh was supposed to correct.
 *
 * Both are driven through promises this file controls, because the failure in
 * each case is about ORDERING and neither reproduces if the requests resolve
 * in the order they were made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn(),
}))
vi.mock('../EditSeriesModal', () => ({ default: () => null }))
vi.mock('../RescheduleModal', () => ({ default: () => null }))
vi.mock('../SkipModal', () => ({ default: () => null }))

import { get } from '../../../api'
import SeriesDetail from '../SeriesDetail'

const series = (over = {}) => ({
  id: 5, client_id: null, title: 'Base', address: '1 Elm St',
  frequency: 'weekly', interval_weeks: 1, days_of_week: [2],
  start_time: '09:00:00', end_time: '12:00:00', active: true,
  anchor_date: '2026-06-02', generate_weeks_ahead: 8, ends_mode: 'never',
  ...over,
})

/** A promise plus the handles to settle it later. */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

function draw(props = {}) {
  return render(
    <MemoryRouter>
      <SeriesDetail id="5" onBack={() => {}} onChanged={() => {}} toast={toast} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  get.mockReset()
  toast.error.mockReset(); toast.success.mockReset()
})
afterEach(cleanup)

describe('a silent refresh that fails keeps the screen', () => {
  it('does not swap the detail for the full-page error branch', async () => {
    get.mockImplementation((url) => {
      if (/^\/api\/recurring\/5$/.test(String(url))) return Promise.resolve(series({ title: 'Loaded fine' }))
      return Promise.resolve([])
    })
    const { rerender } = draw({ refreshToken: 0 })
    expect(await screen.findByText('Loaded fine')).toBeTruthy()

    // The refresh fails outright.
    get.mockImplementation(() => Promise.reject(new Error('network down')))
    rerender(
      <MemoryRouter>
        <SeriesDetail id="5" onBack={() => {}} onChanged={() => {}} toast={toast} refreshToken={1} />
      </MemoryRouter>,
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // The view is intact: still the series, not an error page.
    expect(screen.getByText('Loaded fine'), 'a failed background refresh tore the detail down').toBeTruthy()
    expect(screen.queryByText('network down')).toBeNull()
    expect(screen.queryByRole('button', { name: /Back to list/ })).toBeNull()
    // And it says so, rather than leaving stale data passing as fresh.
    expect(String(toast.error.mock.calls[0][0])).toMatch(/refresh/i)
  })
})

describe('an older response cannot overwrite a newer one', () => {
  /** Mount fetch and refresh fetch, both held open so the order is FORCED
   *  rather than inferred. The first version of this resolved the stale
   *  response immediately after the rerender and trusted microtask ordering to
   *  interleave them — it did not, and a mutation removing the sequence guard
   *  sailed straight through. A race test that cannot lose the race tests
   *  nothing. */
  function openBoth() {
    const mount = deferred()
    const refresh = deferred()
    get.mockImplementation((url) =>
      /^\/api\/recurring\/5$/.test(String(url)) ? mount.promise : Promise.resolve([]))
    const { rerender } = draw({ refreshToken: 0 })
    get.mockImplementation((url) =>
      /^\/api\/recurring\/5$/.test(String(url)) ? refresh.promise : Promise.resolve([]))
    rerender(
      <MemoryRouter>
        <SeriesDetail id="5" onBack={() => {}} onChanged={() => {}} toast={toast} refreshToken={1} />
      </MemoryRouter>,
    )
    return { mount, refresh }
  }

  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

  it('keeps the refreshed series when the mount fetch resolves last', async () => {
    const { mount, refresh } = openBoth()

    // The refresh answers first. The skeleton is still up at this point — the
    // mount load owns `loading` and has not returned — so nothing is asserted
    // about the screen yet, only that the data landed.
    refresh.resolve(series({ title: 'Fresh, after Undo' }))
    await settle()

    // NOW the superseded mount fetch lands with the pre-Undo snapshot, and
    // clears `loading` on its way out.
    mount.resolve(series({ title: 'Stale, from before Undo' }))
    await settle()

    expect(
      screen.queryByText('Stale, from before Undo'),
      'the superseded mount fetch overwrote the refresh',
    ).toBeNull()
    expect(screen.getByText('Fresh, after Undo')).toBeTruthy()
  })

  it('keeps the mount fetch when the refresh that superseded it FAILS', async () => {
    // The blank-screen case (codex P2 on #1161). Undo fires while the mount
    // fetch is still open, so the refresh takes the newer sequence — and then
    // fails. Under a "newest STARTED wins" guard the mount fetch's successful
    // response is discarded by a load that produced nothing: `schedule` stays
    // null, the silent catch sets no error, the mount's `finally` clears
    // `loading`, and the component falls through to `if (!schedule) return
    // null`. An empty screen, from the one request that worked.
    const { mount, refresh } = openBoth()

    refresh.reject(new Error('network down'))
    await settle()

    mount.resolve(series({ title: 'The only answer anyone got' }))
    await settle()

    expect(
      screen.queryByText('The only answer anyone got'),
      'a failed refresh threw away the successful load it superseded',
    ).toBeTruthy()
    // And the failure was still reported — it just did not take the screen.
    expect(toast.error).toHaveBeenCalled()
  })

  it('still shows an error when BOTH loads fail', async () => {
    // The error guard has to key off the applied sequence for the same reason
    // the data guard does. Keyed off the STARTED one, a mount fetch that
    // fails after being superseded by a refresh that ALSO failed is treated
    // as moot — so nothing sets `error`, nothing sets `schedule`, and the
    // screen goes blank again rather than saying what went wrong.
    const { mount, refresh } = openBoth()

    refresh.reject(new Error('refresh failed'))
    await settle()
    mount.reject(new Error('could not load this series'))
    await settle()

    expect(
      screen.queryByText(/could not load this series/i),
      'both loads failed and the screen said nothing',
    ).toBeTruthy()
  })

  it('does not leave the skeleton up forever when a load is superseded', async () => {
    // The sequence guard must NOT be applied to the `loading` flag: a
    // superseded non-silent load that skipped its own cleanup would leave the
    // skeleton on screen permanently, since the silent load never touches it.
    const { mount, refresh } = openBoth()
    refresh.resolve(series({ title: 'Fresh' }))
    await settle()
    mount.resolve(series({ title: 'Stale' }))
    await settle()

    expect(
      screen.getByRole('heading', { name: 'Fresh' }),
      'the skeleton never went away',
    ).toBeTruthy()
  })
})
