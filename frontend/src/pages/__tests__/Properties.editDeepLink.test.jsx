/**
 * The Properties page's `?edit=<id>` deep link, which had no test at all.
 *
 * `PropertyDetail`'s "Edit Property" button navigates here with
 * `?edit=<id>`, and the page reuses the exact `openEdit()` the row's own Edit
 * button calls, then drops the param so back/refresh does not re-open the
 * modal.
 *
 * ## The ordering is the thing worth pinning
 *
 * The effect reads:
 *
 *     const target = properties.find(p => String(p.id) === editId)
 *     if (!target) return          // <- BEFORE the param is stripped
 *     openEdit(target)
 *     next.delete('edit'); setSearchParams(next, { replace: true })
 *
 * On first render `properties` is empty, because the list is still in flight.
 * Returning early — rather than stripping the param and giving up — is what
 * makes the deep link survive the load: the effect re-runs when the rows
 * arrive and opens the modal then.
 *
 * A tidy-up that hoists the strip above the guard ("always clean the URL") is
 * the obvious refactor and it silently breaks this on any connection slower
 * than a test. Nothing would crash; the owner would click Edit Property and
 * land on an unfiltered list. The second case here is that exact scenario,
 * with the rows arriving a tick late.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom'

// `getCached` is here because `useProperties` loads the client book through
// it. A partial mock of ../api is a trap: the missing export is `undefined`,
// the hook calls it, and the page throws before anything renders — so this
// file went red on a change that had nothing to do with the deep link. Mock
// the whole surface the page reaches for, not the part the test is about.
vi.mock('../../api', () => ({
  get: vi.fn(), getCached: vi.fn(), post: vi.fn(), put: vi.fn(),
  patch: vi.fn(), del: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))

import { get, getCached } from '../../api'
import Properties from '../Properties'

const PROPERTIES = [
  { id: 7, name: 'Harbor Cottage', address: '12 Harbor Rd', client_id: 3,
    property_type: 'str', house_code: '8891', access_notes: '' },
  { id: 8, name: 'Elm Street Duplex', address: '4 Elm St', client_id: 3,
    property_type: 'residential', house_code: '', access_notes: '' },
]
const CLIENTS = [{ id: 3, name: 'Anna Sweet' }]

/** `/api/properties` resolves through `gate`, so a test can hold the list
 *  back and reproduce the slow-load case the guard exists for. */
function mockApi({ properties = PROPERTIES, gate = Promise.resolve() } = {}) {
  const route = (url) => {
    if (url.startsWith('/api/properties')) return gate.then(() => properties)
    if (url.startsWith('/api/clients')) return Promise.resolve(CLIENTS)
    return Promise.resolve([])
  }
  // Both helpers, routed the same: the client book comes through `getCached`
  // and the property rows through `get`, and the test does not care which is
  // which — it cares that the deep link survives the load.
  get.mockImplementation(route)
  getCached.mockImplementation(route)
}

function UrlSpy() {
  const [params] = useSearchParams()
  return <div data-testid="url">{params.toString()}</div>
}

function mountAt(search) {
  return render(
    <MemoryRouter initialEntries={[`/properties${search}`]}>
      <Routes>
        <Route path="/properties" element={<><Properties /><UrlSpy /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('Properties: the ?edit= deep link from PropertyDetail', () => {
  it('opens the edit form for the named property and clears the param', async () => {
    mockApi()
    mountAt('?edit=7')

    // The form is populated from the property, so its name is the evidence
    // that the RIGHT one opened rather than a blank create form.
    await waitFor(() => expect(screen.getByDisplayValue('Harbor Cottage')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('url').textContent, 'edit= survived, so a refresh reopens the modal')
        .not.toMatch(/edit=/))
  })

  it('waits for the rows instead of discarding the link while they load', async () => {
    // The case the early return exists for. On first render `properties` is
    // empty; stripping the param there would lose the deep link for good.
    let release
    const gate = new Promise(resolve => { release = resolve })
    mockApi({ gate })
    mountAt('?edit=7')

    // Nothing to open yet, and crucially the param is still there.
    await screen.findByTestId('url')
    expect(screen.queryByDisplayValue('Harbor Cottage')).toBeNull()
    expect(screen.getByTestId('url').textContent,
      'the deep link was discarded before the rows arrived').toMatch(/edit=7/)

    release()
    await waitFor(() => expect(screen.getByDisplayValue('Harbor Cottage')).toBeTruthy())
  })

  it('leaves the page alone for an id that is not there at all', async () => {
    // A stale link, or a property deleted since. No modal, and no crash — the
    // list is still usable.
    mockApi()
    mountAt('?edit=999')
    await waitFor(() => expect(get).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Elm Street Duplex')).toBeTruthy())
    expect(screen.queryByDisplayValue('Harbor Cottage')).toBeNull()
  })

  it('opens nothing when no edit param is given', async () => {
    mockApi()
    mountAt('')
    await waitFor(() => expect(screen.getByText('Harbor Cottage')).toBeTruthy())
    expect(screen.queryByDisplayValue('Harbor Cottage')).toBeNull()
  })
})
