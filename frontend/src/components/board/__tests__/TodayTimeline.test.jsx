/**
 * TodayTimeline — the real Schedule day view embedded on Home.
 *
 * What's worth pinning here is the stuff that isn't DispatchTimeline's job:
 * it fetches exactly ONE day (not a week), it renders each of its three
 * states distinctly, and — the point of the box — an empty day collapses to
 * one line instead of 300px of blank hour grid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))
vi.mock('../../../hooks/useEmployees', () => ({
  useEmployees: () => ({ employees: [], empName: (id) => `Cleaner ${id}` }),
}))

import { get } from '../../../api'
import TodayTimeline from '../TodayTimeline'

const VISIT = {
  id: 11, job_id: 11, start_time: '10:00', end_time: '13:00',
  cleaner_ids: ['c1'], status: 'scheduled',
}
const DAY = {
  visits: [VISIT],
  jobs: [{ id: 11, property_id: 5, client_id: 9, title: 'Turnover', job_type: 'str_turnover' }],
  properties: [{ id: 5, name: '9 Lakeshore Dr', address: '9 Lakeshore Dr', property_type: 'str' }],
  clients: [{ id: 9, name: 'Anna Sweet' }],
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

describe('TodayTimeline', () => {
  it('fetches a single day and draws the visit on the timeline', async () => {
    get.mockResolvedValue(DAY)
    render(<TodayTimeline navigate={vi.fn()} />)

    expect(await screen.findByText('Anna Sweet')).toBeTruthy()

    // One day, not a week: both range params are the same date.
    const url = get.mock.calls[0][0]
    const from = new URL(url, 'http://x').searchParams.get('scheduled_date_from')
    const to = new URL(url, 'http://x').searchParams.get('scheduled_date_to')
    expect(from).toBe(to)
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('collapses an empty day to one line, not a blank hour grid', async () => {
    get.mockResolvedValue({ visits: [], jobs: [], properties: [], clients: [] })
    render(<TodayTimeline navigate={vi.fn()} />)

    expect(await screen.findByText(/nothing on the schedule today/i)).toBeTruthy()
    // The hour axis (06 … 20) must not render at all when there's nothing on it.
    expect(screen.queryByText('06')).toBeNull()
  })

  it('cancelled visits are not counted or drawn', async () => {
    get.mockResolvedValue({ ...DAY, visits: [{ ...VISIT, status: 'cancelled' }] })
    render(<TodayTimeline navigate={vi.fn()} />)

    expect(await screen.findByText(/nothing on the schedule today/i)).toBeTruthy()
  })

  it('shows a retryable message when the day fails to load', async () => {
    get.mockRejectedValue(new Error('offline'))
    render(<TodayTimeline navigate={vi.fn()} />)

    expect(await screen.findByText(/couldn't load today's schedule/i)).toBeTruthy()

    get.mockResolvedValue(DAY)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByText('Anna Sweet')).toBeTruthy())
  })

  it('opening a block navigates to that job', async () => {
    const navigate = vi.fn()
    get.mockResolvedValue(DAY)
    render(<TodayTimeline navigate={navigate} />)

    fireEvent.click(await screen.findByText('Anna Sweet'))
    expect(navigate).toHaveBeenCalledWith('/jobs/11')
  })
})
