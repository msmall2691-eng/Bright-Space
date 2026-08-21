/**
 * ScheduleCalendar — the Week/Month schedule grid on Home.
 *
 * What's worth pinning: it fetches exactly the range that's on screen (and
 * refetches when you page or switch mode), a day's density is visible without
 * opening anything, tapping a day expands that day's real work in place, and
 * unassigned visits are flagged. Plus the three load states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))

import { get } from '../../../api'
import ScheduleCalendar from '../ScheduleCalendar'

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const TODAY = ymd(new Date())

const payload = (visits = []) => ({
  visits,
  jobs: [],
  properties: [{ id: 5, name: '9 Lakeshore Dr' }],
  clients: [{ id: 9, name: 'Anna Sweet' }],
})

const VISIT = {
  id: 11, job_id: 11, property_id: 5, client_id: 9,
  scheduled_date: TODAY, start_time: '10:00', end_time: '13:00',
  cleaner_ids: [], status: 'scheduled', title: 'Turnover',
}

const lastUrl = () => new URL(get.mock.calls[get.mock.calls.length - 1][0], 'http://x')

beforeEach(() => {
  get.mockReset()
  try { localStorage.clear() } catch { /* ignore */ }
})
afterEach(cleanup)

describe('ScheduleCalendar', () => {
  it('fetches exactly the visible range (a Mon–Sun week by default)', async () => {
    get.mockResolvedValue(payload([VISIT]))
    render(<ScheduleCalendar navigate={vi.fn()} />)
    await screen.findByTestId(`cal-day-${TODAY}`)

    const u = lastUrl()
    const from = u.searchParams.get('scheduled_date_from')
    const to = u.searchParams.get('scheduled_date_to')
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Mon-start, 7 days inclusive.
    const days = Math.round((new Date(`${to}T00:00`) - new Date(`${from}T00:00`)) / 86400000)
    expect(days).toBe(6)
    expect(new Date(`${from}T00:00`).getDay()).toBe(1)  // Monday
  })

  it('switching to Month refetches a wider range', async () => {
    get.mockResolvedValue(payload([VISIT]))
    render(<ScheduleCalendar navigate={vi.fn()} />)
    await screen.findByTestId(`cal-day-${TODAY}`)
    const weekCalls = get.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /month/i }))

    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(weekCalls))
    const u = lastUrl()
    const from = u.searchParams.get('scheduled_date_from')
    const to = u.searchParams.get('scheduled_date_to')
    const days = Math.round((new Date(`${to}T00:00`) - new Date(`${from}T00:00`)) / 86400000)
    expect(days).toBeGreaterThanOrEqual(27)   // whole weeks covering a month
  })

  it('shows a day count and flags days with unassigned work', async () => {
    get.mockResolvedValue(payload([VISIT]))   // VISIT has cleaner_ids: []
    render(<ScheduleCalendar navigate={vi.fn()} />)

    const cell = await screen.findByTestId(`cal-day-${TODAY}`)
    expect(cell.textContent).toContain('1')
    expect(within_(cell, '[aria-label="1 unassigned"]')).toBeTruthy()
  })

  it('tapping a day expands that day in place, labelled by property', async () => {
    get.mockResolvedValue(payload([VISIT]))
    render(<ScheduleCalendar navigate={vi.fn()} />)

    fireEvent.click(await screen.findByTestId(`cal-day-${TODAY}`))
    // Property name, not the generic job title.
    expect(await screen.findByText('9 Lakeshore Dr')).toBeTruthy()
    expect(screen.getByText(/needs cleaner/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /open day/i })).toBeTruthy()
  })

  it('a visit in the expanded day opens that job', async () => {
    const navigate = vi.fn()
    get.mockResolvedValue(payload([VISIT]))
    render(<ScheduleCalendar navigate={navigate} />)

    fireEvent.click(await screen.findByTestId(`cal-day-${TODAY}`))
    fireEvent.click(await screen.findByText('9 Lakeshore Dr'))
    expect(navigate).toHaveBeenCalledWith('/jobs/11')
  })

  it('cancelled visits are not counted', async () => {
    get.mockResolvedValue(payload([{ ...VISIT, status: 'cancelled' }]))
    render(<ScheduleCalendar navigate={vi.fn()} />)
    expect(await screen.findByText(/nothing booked this week/i)).toBeTruthy()
  })

  it('shows a retryable message when the range fails to load', async () => {
    get.mockRejectedValue(new Error('offline'))
    render(<ScheduleCalendar navigate={vi.fn()} />)

    expect(await screen.findByText(/couldn't load the schedule/i)).toBeTruthy()
    get.mockResolvedValue(payload([VISIT]))
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByTestId(`cal-day-${TODAY}`)).toBeTruthy())
  })
})

/** Tiny helper: querySelector scoped to an element, returning null-safe. */
function within_(el, selector) {
  return el.querySelector(selector)
}
