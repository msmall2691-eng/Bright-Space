/**
 * Jobs must be FULLY editable in the modal — including the title, which was
 * rendered as plain text in edit mode — and a scheduling conflict must offer
 * an explicit "Save anyway" override instead of dead-ending the save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import JobEditModal from '../JobEditModal'

afterEach(cleanup)

const JOB = {
  id: 5,
  title: 'Original title',
  job_type: 'residential',
  status: 'scheduled',
  property_id: 2,
  address: '1 First St',
  cleaner_ids: [],
  notes: '',
  scheduled_date: '2026-06-20',
  start_time: '09:00:00',
  end_time: '12:00:00',
}

const PROPERTIES = [
  { id: 2, name: 'P1', address: '1 First St', property_type: 'residential', client_id: 9 },
  { id: 3, name: 'P2', address: '2 Second Ave', property_type: 'commercial', client_id: 9 },
]

let fetchCalls

const mockFetch = (patchResponses) => {
  let patchCount = 0
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts })
    if (String(url).includes('/api/dispatch/employees')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if ((opts.method || 'GET') === 'PATCH') {
      const r = patchResponses[Math.min(patchCount, patchResponses.length - 1)]
      patchCount++
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

beforeEach(() => {
  localStorage.setItem('brightbase_jwt', 'test-jwt')
})

describe('JobEditModal — everything editable', () => {
  it('lets you edit the TITLE of an existing job and PATCHes every field', async () => {
    mockFetch([{ status: 200, body: { id: 5 } }])
    const onSave = vi.fn()
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    // The title is an INPUT (it used to be a read-only <p> in edit mode)
    const title = screen.getByDisplayValue('Original title')
    fireEvent.change(title, { target: { value: 'Renamed — deep clean' } })

    // Type, status, and address are editable too
    fireEvent.change(screen.getByDisplayValue('Residential'), { target: { value: 'commercial' } })
    fireEvent.change(screen.getByDisplayValue('Scheduled'), { target: { value: 'in_progress' } })
    fireEvent.change(screen.getByDisplayValue('1 First St'), { target: { value: '99 New Rd' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const patchCall = fetchCalls.find(c => c.opts.method === 'PATCH')
    expect(patchCall.url).toContain('/api/jobs/5')
    const body = JSON.parse(patchCall.opts.body)
    expect(body.title).toBe('Renamed — deep clean')
    expect(body.job_type).toBe('commercial')
    expect(body.status).toBe('in_progress')
    expect(body.address).toBe('99 New Rd')
    expect(body.property_id).toBe(2)              // was silently dropped server-side before
  })

  it('offers "Save anyway" on a scheduling conflict and retries with allow_conflicts', async () => {
    mockFetch([
      { status: 409, body: { detail: 'Conflict: cleaner 7 is double-booked 9:00–12:00' } },
      { status: 200, body: { id: 5 } },
    ])
    const onSave = vi.fn()
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(screen.getByText(/Scheduling conflict/)).toBeDefined())
    expect(screen.getByText(/double-booked/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Save anyway/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const patches = fetchCalls.filter(c => c.opts.method === 'PATCH').map(c => JSON.parse(c.opts.body))
    expect(patches[0].allow_conflicts).toBe(false)
    expect(patches[1].allow_conflicts).toBe(true)  // explicit override, not silent
  })
})
