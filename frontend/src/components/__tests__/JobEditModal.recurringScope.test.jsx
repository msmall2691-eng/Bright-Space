/**
 * What a recurring visit's edit is allowed to touch.
 *
 * Two defects this covers, both reported as "editing one visit messed with the
 * whole recurring schedule":
 *
 *  1. EVERY field edit on a recurring job opened the scope dialog — including
 *     status / pay mode / pay bump, which exist only on the Job row and have no
 *     column on RecurringSchedule. Picking "this and all future" for one of
 *     those ran a real series SPLIT (new schedule, old one retired, every
 *     future visit cancelled and regenerated) and then discarded the field.
 *     Those fields now take the plain single-job PATCH.
 *
 *  2. A scope save shipped title + address + notes + both times + cleaner_ids
 *     off formData every time, so editing one field rewrote the series with
 *     whatever the modal happened to be holding for the other five. Only
 *     fields the operator actually changed go on the wire now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import JobEditModal from '../JobEditModal'

afterEach(cleanup)

const RECURRING_JOB = {
  id: 6,
  recurring_schedule_id: 42,
  title: 'Original title',
  job_type: 'residential',
  pay_mode: 'auto',
  status: 'scheduled',
  property_id: 2,
  address: '1 First St',
  cleaner_ids: ['emp1'],
  notes: 'Original notes',
  scheduled_date: '2026-06-20',
  start_time: '09:00:00',
  end_time: '12:00:00',
}

const PROPERTIES = [
  { id: 2, name: 'P1', address: '1 First St', property_type: 'residential', client_id: 9 },
]

let fetchCalls

const mockFetch = () => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    fetchCalls.push({ url: String(url), method, opts })
    if (String(url).includes('/api/dispatch/employees')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ id: 6, job_id: 6, previous_schedule_id: 42 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

const writes = () => fetchCalls.filter(c => c.method === 'PATCH' || c.method === 'POST')
const bodyOf = (call) => JSON.parse(call.opts.body)

beforeEach(() => {
  localStorage.setItem('brightbase_jwt', 'test-jwt')
  mockFetch()
})

describe('per-visit-only fields never ask about the series', () => {
  it('saves a STATUS change straight to the one job, with no scope dialog', async () => {
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    fireEvent.click(screen.getByTitle('Click to change'))
    fireEvent.click(screen.getByRole('button', { name: 'in progress' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(screen.queryByText('This is a repeating visit')).toBeNull()

    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].method).toBe('PATCH')
    expect(w[0].url).toContain('/api/jobs/6')
    expect(bodyOf(w[0]).status).toBe('in_progress')
    // Nothing series-shaped went anywhere near the recurring endpoints.
    expect(fetchCalls.some(c => c.url.includes('/api/recurring/'))).toBe(false)
  })
})

describe('series fields still ask, and only carry what changed', () => {
  it('names the changed field in the dialog', async () => {
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={() => {}} />)

    const title = screen.getByDisplayValue('Original title')
    fireEvent.change(title, { target: { value: 'Renamed' } })
    fireEvent.blur(title)

    expect(screen.getByText('This is a repeating visit')).toBeDefined()
    expect(screen.getByText('Title')).toBeDefined()
  })

  it('"this and all future" splits with ONLY the edited field, not the whole form', async () => {
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    const title = screen.getByDisplayValue('Original title')
    fireEvent.change(title, { target: { value: 'Renamed' } })
    fireEvent.blur(title)
    fireEvent.click(screen.getByRole('button', { name: /This and all future visits/ }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const split = writes().find(c => c.url.includes('/api/recurring/42/split'))
    expect(split).toBeDefined()
    const body = bodyOf(split)
    expect(body.title).toBe('Renamed')
    expect(body.split_date).toBe('2026-06-20')
    // The untouched fields must not be re-asserted onto the new schedule —
    // split carries them over from the old one on its own.
    expect(body).not.toHaveProperty('notes')
    expect(body).not.toHaveProperty('address')
    expect(body).not.toHaveProperty('cleaner_ids')
    expect(body).not.toHaveProperty('start_time')
    expect(body).not.toHaveProperty('end_time')
    // A pure rename must not repoint the series' day pattern.
    expect(body).not.toHaveProperty('days_of_week')
    expect(body).not.toHaveProperty('day_of_month')
  })

  it('"all visits" resyncs with ONLY the edited field', async () => {
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    // The notes area is already open — showAdvanced defaults on for a job
    // that has notes, so nothing the operator wrote is hidden behind a toggle.
    const notes = screen.getByDisplayValue('Original notes')
    fireEvent.change(notes, { target: { value: 'Gate code changed' } })
    fireEvent.blur(notes)
    fireEvent.click(screen.getByRole('button', { name: /All visits in the series/ }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const call = writes().find(c => c.method === 'PATCH' && c.url.includes('/api/recurring/42'))
    expect(call).toBeDefined()
    const body = bodyOf(call)
    expect(body.notes).toBe('Gate code changed')
    expect(body.resync).toBe(true)
    expect(body).not.toHaveProperty('title')
    expect(body).not.toHaveProperty('cleaner_ids')
    expect(body).not.toHaveProperty('start_time')
  })

  it('a "this visit only" edit with no date/time move stays a single-job PATCH', async () => {
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    // The notes area is already open — showAdvanced defaults on for a job
    // that has notes, so nothing the operator wrote is hidden behind a toggle.
    const notes = screen.getByDisplayValue('Original notes')
    fireEvent.change(notes, { target: { value: 'Leave the key out' } })
    fireEvent.blur(notes)
    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    // No exception row for a change that isn't a move.
    expect(fetchCalls.some(c => c.url.includes('/reschedule'))).toBe(false)
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].url).toContain('/api/jobs/6')
    const body = bodyOf(w[0])
    expect(body.notes).toBe('Leave the key out')
    expect(body).not.toHaveProperty('title')
    expect(body).not.toHaveProperty('status')
  })

  it('a date move DOES repoint the day pattern for "this and all future"', async () => {
    const onSave = vi.fn()
    render(<JobEditModal job={RECURRING_JOB} properties={PROPERTIES} onClose={() => {}} onSave={onSave} />)

    const dateInput = screen.getByDisplayValue('2026-06-20')
    fireEvent.change(dateInput, { target: { value: '2026-06-25' } }) // Sat -> Thu
    fireEvent.click(screen.getByRole('button', { name: /This and all future visits/ }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const body = bodyOf(writes().find(c => c.url.includes('/split')))
    expect(body.days_of_week).toEqual([3]) // Thursday, backend 0=Mon
    expect(body.day_of_week).toBe(3)
    expect(body.day_of_month).toBe(25)
  })
})
