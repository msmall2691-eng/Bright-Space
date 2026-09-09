/**
 * The open-jobs board on a day with nothing booked — what the owner was
 * looking at when she said the crew screen "could definitely be better".
 *
 * Two defects, both visible in that screenshot:
 *
 *   1. Every open job scheduled for TODAY rendered TWICE. The Today section
 *      falls back to the whole board when nothing is assigned, and a separate
 *      "Up for grabs today" section below re-rendered the same rows filtered
 *      to today. A subcontractor scrolling a short board saw the same job
 *      again and could not tell whether it was two jobs or one.
 *
 *   2. An offer named the house. `/api/crew/my-day` carefully nulls `address`,
 *      `property_name` and `client_name` on an open offer — whose house it is
 *      stops being the bidder's business until they have won it — and then
 *      shipped the street address anyway inside `title`, because iCal
 *      turnovers are titled "Turnover — {property.name}" and a property's name
 *      IS its address. The title is stripped server-side now; this pins the
 *      screen that displays it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(),
  logout: vi.fn(), download: vi.fn(),
}))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pushToast: vi.fn(),
}))

import { get, post } from '../../api'
import MyDay from '../MyDay'

const TODAY = '2026-09-07'
const OFFER = {
  id: 41, open: true, title: 'Turnover — Camden ME', area: 'Camden ME',
  scheduled_date: TODAY, start_time: '10:00', end_time: '16:00',
  job_type: 'str_turnover', posted_rate: 140, status: 'scheduled',
  address: null, property_name: null, client_name: null,
}
const DAY = {
  as_of: TODAY, crew_id: 'CT-DANA', first_name: 'Dana',
  today: [], upcoming: [], open_jobs: [OFFER], routes: [], unread_messages: 0,
}

let consoleError
beforeEach(() => {
  get.mockReset(); localStorage.clear()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { consoleError.mockRestore(); cleanup(); localStorage.clear() })

const show = async (payload = DAY) => {
  get.mockResolvedValue(payload)
  render(<MemoryRouter><MyDay /></MemoryRouter>)
  await waitFor(() => expect(get).toHaveBeenCalled())
  await screen.findByText('My Day')
}

it('lists an open job once on a day with nothing booked', async () => {
  await show()
  await waitFor(() => expect(screen.queryAllByText(/Camden ME/).length)
    .toBeGreaterThan(0))
  // The board is the ONE place this job appears. Twice is the bug.
  expect(screen.getAllByRole('button', { name: /ask for this job/i })).toHaveLength(1)
})

it('still lists it once when the day does have work booked', async () => {
  const assigned = {
    id: 7, title: 'Portland — Residential Cleaning', scheduled_date: TODAY,
    start_time: '09:00', end_time: '12:00', status: 'scheduled',
    address: '9 Elm St, Portland ME',
  }
  await show({ ...DAY, today: [assigned] })
  expect(screen.getAllByRole('button', { name: /ask for this job/i })).toHaveLength(1)
})

// ── The day-at-a-glance dashboard (what makes home more than a jobs list) ────

it('leads the home with a glance: this week, up for grabs, messages', async () => {
  await show({ ...DAY, week: { week_total: 430, earned_total: 120 },
               open_jobs: [OFFER], unread_messages: 2 })
  expect(await screen.findByText('this week')).toBeTruthy()
  expect(screen.getByText('$430.00')).toBeTruthy()   // rides the payload, no extra fetch
  expect(screen.getByText('up for grabs')).toBeTruthy()
  expect(screen.getByText('messages')).toBeTruthy()
})

it('the "up for grabs" tile jumps to the Open jobs tab', async () => {
  await show({ ...DAY, week: { week_total: 430 }, open_jobs: [OFFER], unread_messages: 0 })
  fireEvent.click(screen.getByText('up for grabs').closest('button'))
  // The header only says "Open jobs" on the Jobs tab, so this proves the jump.
  expect(await screen.findByText('Open jobs')).toBeTruthy()
})

it('shows the glance no money yet as a dash, not a crash', async () => {
  await show({ ...DAY, week: null, open_jobs: [], unread_messages: 0 })
  expect(await screen.findByText('this week')).toBeTruthy()
  expect(screen.getByText('—')).toBeTruthy()
})

it('hides the glance from a sub who is not cleared yet', async () => {
  // A row of zeros under "you're not cleared" is noise; the file card carries
  // the message instead.
  await show({ ...DAY, cleared: false, missing: ['Upload your insurance'], week: null })
  expect(await screen.findByText(/not cleared to take jobs yet/i)).toBeTruthy()
  expect(screen.queryByText('up for grabs')).toBeNull()
})

it('says which day an offer is for', async () => {
  // The board spans dates. "09:00 – 13:00" under a heading about today reads
  // as today, and a sub who drives out on the wrong morning has been misled
  // by the screen rather than by anyone.
  await show({ ...DAY, open_jobs: [{ ...OFFER, scheduled_date: '2026-09-10' }] })
  await waitFor(() => expect(document.body.textContent).toMatch(/Sep 10/))
})


it('asking for a job opens the sheet and files the request', async () => {
  // The assertion that was missing. The other tests prove the BUTTON exists;
  // #777 deleted the sheet it opens, so the button set state that nothing
  // rendered — no sheet, no rate field, no POST, no feedback. A test that only
  // finds the button passes on a dead button. This one clicks it.
  post.mockResolvedValue({ auto_approved: false })
  await show()

  fireEvent.click(screen.getByRole('button', { name: /ask for this job/i }))

  // The sheet — the render that regressed — is what carries the confirm.
  const send = await screen.findByRole('button', { name: /send request/i })
  fireEvent.click(send)

  // Empty rate box means "your posted price is fine" — null, not 0.
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/crew/jobs/41/claim',
    { requested_rate: null, message: null },
  ))
})

it('claims instantly when the office has instant claiming on', async () => {
  // The same board, but the office turned instant claiming on: the backend
  // stamps instant_claim on the offer, and the copy follows it — "Claim this
  // job" and "Claim it", not the ask wording. Proves the flag flows through.
  post.mockResolvedValue({ auto_approved: true })
  await show({ ...DAY, open_jobs: [{ ...OFFER, instant_claim: true }] })
  fireEvent.click(screen.getByRole('button', { name: /claim this job/i }))
  const send = await screen.findByRole('button', { name: /claim it/i })
  fireEvent.click(send)
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/crew/jobs/41/claim', { requested_rate: null, message: null }))
})

it('never puts the house on an offer', async () => {
  await show()
  const page = document.body.textContent
  expect(page).not.toMatch(/22 Kincaid|Elm St|Red Barn/)
  // What a bidder legitimately gets: the town and what it pays.
  expect(page).toMatch(/Camden/)
})

// ── The dedicated Jobs tab (the marketplace's real home) ────────────────────

it('has a Jobs tab that lists every open job to claim', async () => {
  // The board used to hide on Today-when-empty and inside Schedule. Now it has
  // its own tap. A day WITH work booked still surfaces the whole board here.
  const assigned = {
    id: 7, title: 'Portland job', scheduled_date: TODAY, status: 'scheduled',
    start_time: '09:00', end_time: '12:00', address: '9 Elm St, Portland ME',
  }
  await show({ ...DAY, today: [assigned] })
  fireEvent.click(screen.getByRole('button', { name: 'Jobs' }))
  expect(await screen.findByText('Open jobs')).toBeTruthy()      // the header
  expect(screen.getByText(/Camden ME/)).toBeTruthy()             // the offer
  expect(screen.getByRole('button', { name: /ask for this job/i })).toBeTruthy()
})

it('the Jobs tab tells an uncleared sub why it is empty', async () => {
  // Same anti-"dead market" rule as Today: an uncleared sub sees why, not a
  // bare empty board.
  await show({ ...DAY, open_jobs: [], cleared: false, missing: ['Upload your insurance'] })
  fireEvent.click(screen.getByRole('button', { name: 'Jobs' }))
  expect(await screen.findByText(/not cleared to take jobs yet/i)).toBeTruthy()
  expect(screen.getByText('Upload your insurance')).toBeTruthy()
})
