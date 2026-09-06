/**
 * "I tried to edit Anna Sweet on Thursday and it messed with the recurring
 * schedule." — the owner.
 *
 * The job page is reachable from every visit card in the app, and until this
 * change it had no idea recurrence existed: `grep -c recurring JobDetail.jsx`
 * was zero. Every field, the date included, went out as a bare
 * `PATCH /api/jobs/{id}`. For a visit belonging to a series that's the exact
 * write the recurrence machinery exists to prevent — the rule keeps its own
 * copy of that date, so the visit moves, the rule doesn't, and the next
 * generation tick puts the original back as a duplicate.
 *
 * The Schedule page's drawer and its drag-to-reschedule both asked the scope
 * question. This page didn't, and nothing on screen said the visit repeated.
 *
 * What's pinned here:
 *   - a recurring visit's date/time edit ASKS before it writes, and cancelling
 *     writes nothing;
 *   - the answer routes through the shared reschedule helper, not a job PATCH;
 *   - a one-time job is untouched by any of this — it still patches directly;
 *   - fields that describe THIS visit (title, address) still patch directly
 *     even on a recurring job. A series-wide prompt for a typo in a title
 *     would be its own kind of wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), patch: vi.fn(), post: vi.fn(), del: vi.fn(), download: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))
// The activity feed opens its own connection and isn't what's under test.
vi.mock('../../components/Timeline', () => ({
  default: () => null, jobTimelineSource: () => ({}),
}))

import { get, patch, post } from '../../api'
import JobDetail from '../JobDetail'

const JOB = {
  id: 6,
  title: 'Anna Sweet — weekly',
  status: 'scheduled',
  scheduled_date: '2026-06-18',
  start_time: '09:00',
  end_time: '12:00',
  address: '1 First St',
  client_id: 9,
  cleaner_ids: [4],
  recurring_schedule_id: 42,
}
const ONE_OFF = { ...JOB, id: 7, recurring_schedule_id: null }

const mount = (job) => {
  get.mockImplementation(url =>
    String(url).includes('/details') ? Promise.resolve(job) : Promise.resolve([]))
  return render(
    <MemoryRouter initialEntries={[`/jobs/${job.id}`]}>
      <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
    </MemoryRouter>,
  )
}

/** Click the labelled inline field open, type, and blur to commit. */
const editField = async (label, value) => {
  fireEvent.click((await screen.findByText(label)).parentElement.querySelector('button'))
  const input = document.querySelector('input:focus')
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin' }))
  get.mockReset(); patch.mockReset(); post.mockReset()
  patch.mockResolvedValue({})
  post.mockResolvedValue({ job_id: 6 })
})
afterEach(cleanup)

describe('JobDetail — a visit that belongs to a series', () => {
  it('says so before she edits anything, and links to the series', async () => {
    mount(JOB)
    expect(await screen.findByText(/This visit repeats/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'See the series' })
      .getAttribute('href')).toBe('/recurring?series=42')
  })

  it('asks what a date change applies to instead of patching the job', async () => {
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Scheduled date', '2026-06-25')

    expect(await screen.findByText('This is a repeating visit')).toBeTruthy()
    // Nothing has been written yet — the question comes first.
    expect(patch).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('writes through the recurrence endpoint once she answers', async () => {
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Scheduled date', '2026-06-25')
    fireEvent.click(await screen.findByRole('button', { name: /This visit only/ }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, body] = post.mock.calls[0]
    // The shared helper's endpoint — the same one the calendar drag uses.
    expect(url).toBe('/api/recurring/42/reschedule')
    expect(body.exception_date).toBe('2026-06-18')
    expect(body.rescheduled_date).toBe('2026-06-25')
    // Stamped so the series' Overrides history says where this came from,
    // rather than claiming a calendar drag that never happened.
    expect(body.reason).toBe('Rescheduled from the job page')
    expect(patch).not.toHaveBeenCalledWith('/api/jobs/6', expect.anything())
  })

  it('names the field it is about to apply, like the edit drawer does', async () => {
    // Picking a blast radius shouldn't mean guessing what's in the blast. The
    // label comes from the shared FIELD_LABELS map, so the two screens that
    // open this dialog can't drift into calling the same field two things.
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Scheduled date', '2026-06-25')
    expect(await screen.findByText('Date')).toBeTruthy()
  })

  it('writes nothing at all when she backs out', async () => {
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Scheduled date', '2026-06-25')
    fireEvent.click(await screen.findByRole('button', { name: 'Never mind' }))

    expect(screen.queryByText('This is a repeating visit')).toBeNull()
    expect(post).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('asks about a time change too — the visit still moves', async () => {
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Start', '10:30')
    expect(await screen.findByText('This is a repeating visit')).toBeTruthy()
    expect(patch).not.toHaveBeenCalled()
  })

  it('still patches a field that only describes this visit', async () => {
    // Title, address, notes and status say what THIS cleaning is. Routing them
    // through a series-wide prompt would be its own kind of wrong.
    mount(JOB)
    await screen.findByText(/This visit repeats/)
    await editField('Address', '2 Second Ave')

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/6', { address: '2 Second Ave' }))
    expect(screen.queryByText('This is a repeating visit')).toBeNull()
  })
})

describe('JobDetail — a one-time job is untouched by any of this', () => {
  it('patches the date straight through, with no prompt and no series notice', async () => {
    mount(ONE_OFF)
    await screen.findByText('Scheduled date')
    expect(screen.queryByText(/This visit repeats/)).toBeNull()

    await editField('Scheduled date', '2026-06-25')
    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/7', { scheduled_date: '2026-06-25' }))
    expect(screen.queryByText('This is a repeating visit')).toBeNull()
  })
})
