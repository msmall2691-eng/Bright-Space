/**
 * UpcomingWeek — the next 7 days of work on Home, grouped by day.
 *
 * The behaviour worth pinning is the reason this replaced a today-only box:
 * a quiet today must NOT read as an empty week when later days are booked.
 * Plus the usual three states, and that empty days are omitted rather than
 * rendered as padding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))
vi.mock('../../../hooks/useEmployees', () => ({
  useEmployees: () => ({ employees: [], empName: (id) => `Cleaner ${id}` }),
}))

import { get } from '../../../api'
import UpcomingWeek from '../UpcomingWeek'

const ymd = (offsetDays) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const WEEK = {
  visits: [
    { id: 11, job_id: 11, scheduled_date: ymd(2), start_time: '10:00', end_time: '13:00',
      cleaner_ids: [], status: 'scheduled' },
    { id: 12, job_id: 12, scheduled_date: ymd(3), start_time: '09:00', end_time: '11:00',
      cleaner_ids: ['c1'], status: 'scheduled' },
  ],
  jobs: [
    { id: 11, property_id: 5, client_id: 9, title: 'Turnover', job_type: 'str_turnover' },
    { id: 12, property_id: 6, client_id: 9, title: 'Clean', job_type: 'residential' },
  ],
  properties: [
    { id: 5, name: '9 Lakeshore Dr', property_type: 'str' },
    { id: 6, name: '4 Red Barn Circle', property_type: 'residential' },
  ],
  clients: [{ id: 9, name: 'Anna Sweet' }],
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

describe('UpcomingWeek', () => {
  it('fetches a 7-day range, not a single day', async () => {
    get.mockResolvedValue(WEEK)
    render(<UpcomingWeek navigate={vi.fn()} />)
    await screen.findByText('9 Lakeshore Dr')

    const url = new URL(get.mock.calls[0][0], 'http://x')
    const from = url.searchParams.get('scheduled_date_from')
    const to = url.searchParams.get('scheduled_date_to')
    expect(from).toBe(ymd(0))
    expect(to).toBe(ymd(6))
    expect(from).not.toBe(to)
  })

  // The whole reason this replaced the today-only timeline.
  it('still shows later-week work when today is empty', async () => {
    get.mockResolvedValue(WEEK)   // nothing on ymd(0)
    render(<UpcomingWeek navigate={vi.fn()} />)

    expect(await screen.findByText('9 Lakeshore Dr')).toBeTruthy()
    expect(screen.getByText('4 Red Barn Circle')).toBeTruthy()
    expect(screen.queryByText(/nothing booked/i)).toBeNull()
    // Days with no work aren't rendered as empty padding rows.
    expect(screen.queryByText('Today')).toBeNull()
  })

  it('groups under day headers and marks unassigned work', async () => {
    get.mockResolvedValue(WEEK)
    render(<UpcomingWeek navigate={vi.fn()} />)
    await screen.findByText('9 Lakeshore Dr')

    // The no-crew visit reads as needing one; the crewed one names the cleaner.
    expect(screen.getByText(/needs cleaner/i)).toBeTruthy()
    expect(screen.getByText('Cleaner c1')).toBeTruthy()
  })

  it('a day header deep-links to that day on the schedule', async () => {
    const navigate = vi.fn()
    get.mockResolvedValue(WEEK)
    render(<UpcomingWeek navigate={navigate} />)
    await screen.findByText('9 Lakeshore Dr')

    fireEvent.click(screen.getByTestId(`day-header-${ymd(2)}`))
    expect(navigate).toHaveBeenCalledWith(`/schedule?date=${ymd(2)}`)
  })

  it('cancelled visits are not counted or drawn', async () => {
    get.mockResolvedValue({
      ...WEEK,
      visits: WEEK.visits.map(v => ({ ...v, status: 'cancelled' })),
    })
    render(<UpcomingWeek navigate={vi.fn()} />)
    expect(await screen.findByText(/nothing booked in the next 7 days/i)).toBeTruthy()
  })

  it('shows a retryable message when the week fails to load', async () => {
    get.mockRejectedValue(new Error('offline'))
    render(<UpcomingWeek navigate={vi.fn()} />)

    expect(await screen.findByText(/couldn't load the schedule/i)).toBeTruthy()
    get.mockResolvedValue(WEEK)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByText('9 Lakeshore Dr')).toBeTruthy())
  })

  it('opening a visit navigates to that job', async () => {
    const navigate = vi.fn()
    get.mockResolvedValue(WEEK)
    render(<UpcomingWeek navigate={navigate} />)

    fireEvent.click(await screen.findByText('9 Lakeshore Dr'))
    expect(navigate).toHaveBeenCalledWith('/jobs/11')
  })

  it('keeps an untimed visit visible rather than dropping it', async () => {
    get.mockResolvedValue({
      ...WEEK,
      visits: [{ ...WEEK.visits[0], start_time: null, end_time: null }],
    })
    render(<UpcomingWeek navigate={vi.fn()} />)
    expect(await screen.findByText('9 Lakeshore Dr')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
  })
})
