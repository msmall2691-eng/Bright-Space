/**
 * Adding a cleaner on the Crew page clears the roster every assign UI reads.
 *
 * `api.invalidateCached` is the mechanism and has its own cases in
 * `__tests__/cacheInvalidation.test.js`. This pins the WIRING, which is the
 * part that rots: the Crew page reads `/api/crew/roster` while every
 * assignment drop-down reads `/api/dispatch/employees` through `useEmployees`,
 * memoised for two minutes. Nothing about editing this page makes that second
 * URL visible, so the call is easy to drop in a later refactor and nothing
 * else would notice.
 *
 * Both write paths are covered, because a crew-ID edit is not cosmetic:
 * `/api/dispatch/employees` is keyed on `cleaner_id` and omits rows without
 * one, so clearing a crew ID removes that person from every assignment UI in
 * the app.
 *
 * Counts real `fetch` calls through the real `getCached`, for the reason given
 * in `components/schedule/__tests__/availabilityRoster.test.jsx`: mocking the
 * api module would stub out the very caching under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const ROSTER = '/api/dispatch/employees'

let fetchMock
let rosterRows      // what GET /api/crew/roster (this page's own list) returns
const rosterCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(ROSTER)).length

const json = (body) => ({
  ok: true, status: 200, headers: { get: () => null }, json: async () => body,
})

beforeEach(() => {
  vi.resetModules()          // getCached's store is module-level
  // The add form sits inside `<fieldset disabled={!isAdmin}>`, and isAdmin
  // reads the stored user. Without this the inputs are inert and the test
  // would "pass" by never submitting anything.
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin' }))
  rosterRows = []
  fetchMock = vi.fn(async (url, opts) => {
    const u = String(url)
    if (u.includes('/api/crew/roster')) return json(rosterRows)
    if (u.includes('/api/crew/unclaimed-ids')) return json([])
    if (u.includes(ROSTER)) return json([{ id: 7, name: 'Dana' }])
    if (u.includes('/api/crew') && opts?.method === 'POST') {
      return json({ id: 2, full_name: 'Sam', email: 's@x.com', cleaner_id: '12' })
    }
    return json([])
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the Crew page keeps the shared roster fresh', () => {
  it('drops the cached roster after a cleaner is added', async () => {
    const { getCached } = await import('../../api')
    const { ROSTER_CACHE_URL } = await import('../../hooks/useEmployees')
    const Crew = (await import('../Crew')).default

    // Warm the cache the way opening Schedule would.
    await getCached(ROSTER_CACHE_URL, 120000)
    expect(rosterCalls()).toBe(1)

    render(<MemoryRouter><Crew /></MemoryRouter>)
    await waitFor(() => expect(screen.getByPlaceholderText(/full name/i)).toBeTruthy())

    // Exact placeholders: the InviteCleaners block on this page has its own
    // "Email" input, so /email/i matches two fields and a loose query would
    // fill the wrong form.
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Sam' } })
    fireEvent.change(screen.getByPlaceholderText('cleaner@email.com'), { target: { value: 's@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: /add & send invite/i }))

    await waitFor(() => expect(
      fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/api/crew') && o?.method === 'POST'),
    ).toBe(true))

    // The next assign UI to mount must go back to the server.
    await getCached(ROSTER_CACHE_URL, 120000)
    expect(rosterCalls(),
      'the roster memo survived the add, so every assign drop-down is missing '
      + 'the new cleaner for up to two minutes').toBe(2)
  })

  it('drops it after a crew-ID edit, which changes who is assignable at all', async () => {
    // Not a cosmetic edit. /api/dispatch/employees is keyed on cleaner_id and
    // omits rows without one, so clearing a crew ID removes that person from
    // every assignment UI — and setting one adds them. Left unpinned, this
    // call site reverts silently: the first version of this file covered only
    // the add path and stayed green when the savePatch call was deleted.
    rosterRows = [{ id: 7, full_name: 'Dana', email: 'd@x.com', cleaner_id: '12' }]

    const { getCached } = await import('../../api')
    const { ROSTER_CACHE_URL } = await import('../../hooks/useEmployees')
    const Crew = (await import('../Crew')).default

    await getCached(ROSTER_CACHE_URL, 120000)
    expect(rosterCalls()).toBe(1)

    render(<MemoryRouter><Crew /></MemoryRouter>)
    const crewId = await screen.findByDisplayValue('12')

    // The edit commits on blur, not on change.
    fireEvent.change(crewId, { target: { value: '99' } })
    fireEvent.blur(crewId)

    await waitFor(() => expect(
      fetchMock.mock.calls.some(([u, o]) => String(u).includes('/api/auth/users/7') && o?.method === 'PATCH'),
    ).toBe(true))

    await getCached(ROSTER_CACHE_URL, 120000)
    expect(rosterCalls(),
      'the roster memo survived a crew-ID change, so the assign drop-downs '
      + 'still list them under the old ID').toBe(2)
  })
})
