/**
 * The house photo on the crew job card.
 *
 * A cleaner should see the front of the house before they pull in. The photo
 * is the assigned-only crew endpoint (the card gates it the same way the
 * backend does), and it never rides an open-offer card — an offer has no
 * address and must not reveal which house it is.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import JobCard from '../JobCard'

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:stub')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mockFetchOk() {
  const blob = new Blob(['x'], { type: 'image/jpeg' })
  const spy = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) })
  vi.stubGlobal('fetch', spy)
  return spy
}

const BASE = {
  id: 42, title: 'Clean', property_name: 'Harbour St', status: 'scheduled',
  scheduled_date: '2026-09-10', job_type: 'residential',
  client_name: 'Dana', my_helpers: [], house_notes: [],
}
const show = (job) => render(<MemoryRouter><JobCard job={job} /></MemoryRouter>)
const photoCalls = (spy) => spy.mock.calls.filter(c => String(c[0]).includes('/property-photo'))

it('loads the assigned job photo from the crew endpoint', async () => {
  const spy = mockFetchOk()
  show({ ...BASE, open: false, address: '9 Oak St' })
  await waitFor(() => expect(photoCalls(spy).length).toBeGreaterThan(0))
  expect(photoCalls(spy)[0][0]).toBe('/api/crew/jobs/42/property-photo')
})

it('never requests a photo for an open offer', async () => {
  const spy = mockFetchOk()
  show({ ...BASE, open: true, address: null, posted_rate: 80 })
  // Give any mount-time effects a tick to fire.
  await new Promise(r => setTimeout(r, 20))
  expect(photoCalls(spy)).toHaveLength(0)
})
