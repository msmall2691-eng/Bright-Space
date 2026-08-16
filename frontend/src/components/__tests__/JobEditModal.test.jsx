/**
 * JobEditModal interaction-model conversion (batch Save button -> per-field
 * auto-save, matching JobDetail's InlineEditField/InlineSelect pattern):
 *
 *  - An existing job's fields each PATCH independently on blur/change; there
 *    is no more global "Save Changes" button or one-shot batched PATCH.
 *  - A scheduling conflict (409) on a per-field PATCH still offers an
 *    explicit "Save anyway" override, retrying that SAME field's payload
 *    with allow_conflicts — never a different or stale payload.
 *  - A recurring job's field edit still can't silently auto-save: it opens
 *    the SAME this/future/all scope dialog the old global Save button used
 *    to show, and the write only happens once the operator resolves it.
 *  - A brand-new job (no id yet) still batches every field into one POST via
 *    an explicit "Create Job" button — there's nothing to auto-save against
 *    before the record exists.
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

const RECURRING_JOB = { ...JOB, id: 6, recurring_schedule_id: 42 }

const PROPERTIES = [
  { id: 2, name: 'P1', address: '1 First St', property_type: 'residential', client_id: 9 },
  { id: 3, name: 'P2', address: '2 Second Ave', property_type: 'commercial', client_id: 9 },
]

let fetchCalls

// Generic URL/method-routed fetch stub. `handlers` is a list of
// [urlSubstring, method, response] tuples checked in order; anything
// unmatched (the debounced cleaner-availability / property-availability
// background GETs this modal always fires) gets a bare 200 {}.
const mockFetch = (handlers) => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    fetchCalls.push({ url: String(url), method, opts })
    if (String(url).includes('/api/dispatch/employees')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    for (const [pattern, m, resp] of handlers) {
      if (String(url).includes(pattern) && (!m || m === method)) {
        return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { 'Content-Type': 'application/json' } })
      }
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

beforeEach(() => {
  localStorage.setItem('brightbase_jwt', 'test-jwt')
})

describe('JobEditModal — per-field auto-save (existing, non-recurring job)', () => {
  it('auto-saves the TITLE field on blur, independently of every other field', async () => {
    mockFetch([['/api/jobs/5', 'PATCH', { status: 200, body: { id: 5, title: 'Renamed — deep clean' } }]])
    const onSave = vi.fn()
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    const title = screen.getByDisplayValue('Original title')
    fireEvent.change(title, { target: { value: 'Renamed — deep clean' } })
    fireEvent.blur(title)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const patchCall = fetchCalls.find(c => c.method === 'PATCH')
    expect(patchCall.url).toContain('/api/jobs/5')
    const body = JSON.parse(patchCall.opts.body)
    expect(body.title).toBe('Renamed — deep clean')
    // Only the field that was actually edited goes on the wire — no more
    // full-job batch payload.
    expect(body).not.toHaveProperty('status')
    expect(body).not.toHaveProperty('address')
    expect(body).not.toHaveProperty('job_type')

    // No global Save button any more for an existing job — Close is the
    // only footer action.
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull()
  })

  it('does not re-PATCH on blur when the field was not actually changed', async () => {
    mockFetch([['/api/jobs/5', 'PATCH', { status: 200, body: { id: 5 } }]])
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={() => {}} />)

    const title = screen.getByDisplayValue('Original title')
    fireEvent.focus(title)
    fireEvent.blur(title) // no edit in between

    await new Promise(r => setTimeout(r, 10))
    expect(fetchCalls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('auto-saves STATUS via InlineSelect the moment a new value is picked', async () => {
    mockFetch([['/api/jobs/5', 'PATCH', { status: 200, body: { id: 5, status: 'in_progress' } }]])
    const onSave = vi.fn()
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    fireEvent.click(screen.getByTitle('Click to change'))
    fireEvent.click(screen.getByRole('button', { name: 'in progress' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const body = JSON.parse(fetchCalls.find(c => c.method === 'PATCH').opts.body)
    expect(body.status).toBe('in_progress')
    expect(body).not.toHaveProperty('title')
  })

  it('offers "Save anyway" on a scheduling conflict and retries the SAME field with allow_conflicts', async () => {
    let patchCount = 0
    fetchCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method || 'GET'
      fetchCalls.push({ url: String(url), method, opts })
      if (String(url).includes('/api/dispatch/employees')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (method === 'PATCH' && String(url).includes('/api/jobs/5')) {
        patchCount++
        if (patchCount === 1) {
          return new Response(JSON.stringify({ detail: 'Conflict: cleaner 7 is double-booked 9:00–12:00' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ id: 5 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const onSave = vi.fn()
    render(<JobEditModal job={JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    const dateInput = screen.getByDisplayValue('2026-06-20')
    fireEvent.change(dateInput, { target: { value: '2026-06-21' } })

    await waitFor(() => expect(screen.getByText(/Scheduling conflict/)).toBeDefined())
    expect(screen.getByText(/double-booked/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Save anyway/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const patches = fetchCalls
      .filter(c => c.method === 'PATCH' && c.url.includes('/api/jobs/5'))
      .map(c => JSON.parse(c.opts.body))
    expect(patches).toHaveLength(2)
    expect(patches[0].scheduled_date).toBe('2026-06-21')
    expect(patches[0].allow_conflicts).toBe(false)
    expect(patches[1].scheduled_date).toBe('2026-06-21') // same payload retried, not a different one
    expect(patches[1].allow_conflicts).toBe(true) // explicit override, not silent
  })
})

describe('JobEditModal — recurring job field edits still require a scope choice', () => {
  it('opens the this/future/all dialog on a field edit and only writes once a scope is chosen', async () => {
    mockFetch([['/api/jobs/6', 'PATCH', { status: 200, body: { id: 6 } }]])
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }))
    const notes = screen.getByPlaceholderText('Add any notes about this job...')
    fireEvent.change(notes, { target: { value: 'Gate code changed' } })
    fireEvent.blur(notes)

    // The scope prompt interrupts BEFORE any write happens — same dialog the
    // old global Save button used to trigger.
    expect(screen.getByText('This is a repeating visit')).toBeDefined()
    expect(fetchCalls.some(c => c.method === 'PATCH')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const patchCall = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('/api/jobs/6'))
    expect(JSON.parse(patchCall.opts.body).notes).toBe('Gate code changed')
  })

  it('"Never mind" on the dialog keeps the edit pending instead of discarding it', async () => {
    mockFetch([['/api/jobs/6', 'PATCH', { status: 200, body: { id: 6 } }]])
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    const title = screen.getByDisplayValue('Original title')
    fireEvent.change(title, { target: { value: 'Edited while recurring' } })
    fireEvent.blur(title)
    expect(screen.getByText('This is a repeating visit')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }))
    expect(screen.queryByText('This is a repeating visit')).toBeNull()
    expect(fetchCalls.some(c => c.method === 'PATCH')).toBe(false)

    // Editing again re-opens the prompt and the earlier edit is still there
    // to be saved — it wasn't silently lost by cancelling.
    fireEvent.blur(title)
    expect(screen.getByText('This is a repeating visit')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const patchCall = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('/api/jobs/6'))
    expect(JSON.parse(patchCall.opts.body).title).toBe('Edited while recurring')
  })
})

describe('JobEditModal — creating a new job still batches', () => {
  it('the Create Job button POSTs every field at once (no id exists yet to auto-save against)', async () => {
    mockFetch([['/api/jobs', 'POST', { status: 200, body: { id: 99 } }]])
    const onSave = vi.fn()
    const { container } = render(
      <JobEditModal job={null} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />
    )

    fireEvent.change(screen.getByPlaceholderText(/Job title/), { target: { value: 'New job' } })
    const propertySelect = screen.getByText('Select a property...').closest('select')
    fireEvent.change(propertySelect, { target: { value: '2' } })
    const dateInput = container.querySelector('input[type="date"]')
    fireEvent.change(dateInput, { target: { value: '2026-07-01' } })

    // None of that fired a PATCH — a new job has no id to auto-save against.
    expect(fetchCalls.some(c => c.method === 'PATCH')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Create Job' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/api/jobs'))
    const body = JSON.parse(postCall.opts.body)
    expect(body.title).toBe('New job')
    expect(body.property_id).toBe(2)
    expect(body.scheduled_date).toBe('2026-07-01')
  })
})
