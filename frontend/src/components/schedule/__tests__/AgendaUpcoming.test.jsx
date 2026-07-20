import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const get = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a) }))

import AgendaUpcoming from '../AgendaUpcoming'

const PAYLOAD = {
  visits: [
    { id: 1, job_id: 10, scheduled_date: '2026-08-01', start_time: '09:00:00', status: 'scheduled' },
    { id: 2, job_id: 11, scheduled_date: '2026-08-02', start_time: '10:00:00', status: 'scheduled' },
    { id: 3, job_id: 12, scheduled_date: '2026-08-01', start_time: '13:00:00', status: 'cancelled' },
  ],
  jobs: [
    { id: 10, title: 'Clean Alice', property_id: 100, client_id: 1000, job_type: 'residential' },
    { id: 11, title: 'Turnover Bob', property_id: 101, client_id: 1001, job_type: 'str_turnover' },
    { id: 12, title: 'Cancelled One', property_id: 100, client_id: 1000, job_type: 'residential' },
  ],
  properties: [
    { id: 100, address: '1 A St', property_type: 'residential' },
    { id: 101, address: '2 B St', property_type: 'str' },
  ],
  clients: [{ id: 1000, name: 'Alice' }, { id: 1001, name: 'Bob' }],
}

const renderView = (props = {}) =>
  render(<MemoryRouter><AgendaUpcoming onSelect={props.onSelect || (() => {})} {...props} /></MemoryRouter>)

beforeEach(() => { get.mockResolvedValue(PAYLOAD) })
afterEach(() => { cleanup(); get.mockReset() })

describe('AgendaUpcoming', () => {
  it('fetches a wide window and groups active jobs by day', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('Clean Alice')).toBeTruthy())
    // Cancelled visits are excluded from the "what's coming" list.
    expect(screen.queryByText('Cancelled One')).toBeNull()
    // Two active jobs across two days.
    expect(screen.getByText(/2 jobs · next 45 days/)).toBeTruthy()
    expect(screen.getByText('Turnover Bob')).toBeTruthy()
    // Fetched the schedule-week endpoint with a from/to range.
    expect(get.mock.calls[0][0]).toMatch(/\/api\/schedule\/week\?scheduled_date_from=.*&scheduled_date_to=/)
  })

  it('opens the drawer via onSelect when a card is tapped', async () => {
    const onSelect = vi.fn()
    renderView({ onSelect })
    await waitFor(() => expect(screen.getByText('Clean Alice')).toBeTruthy())
    fireEvent.click(screen.getByText('Clean Alice').closest('button'))
    expect(onSelect).toHaveBeenCalled()
    expect(onSelect.mock.calls[0][0].id).toBe(1)  // the visit
  })

  it('adds a job on a specific day via the day header +Add', async () => {
    const onCreateForDay = vi.fn()
    renderView({ onCreateForDay })
    await waitFor(() => expect(screen.getByText('Clean Alice')).toBeTruthy())
    fireEvent.click(screen.getAllByText('Add')[0])
    expect(onCreateForDay).toHaveBeenCalledWith('2026-08-01')
  })

  it('honors the property-type filter', async () => {
    renderView({ propertyTypeFilter: 'str' })
    await waitFor(() => expect(screen.getByText('Turnover Bob')).toBeTruthy())
    // Residential is filtered out when only STR is requested.
    expect(screen.queryByText('Clean Alice')).toBeNull()
    expect(screen.getByText(/1 job · next 45 days/)).toBeTruthy()
  })

  it('shows an empty state when nothing is coming up', async () => {
    get.mockResolvedValue({ visits: [], jobs: [], properties: [], clients: [] })
    renderView()
    await waitFor(() => expect(screen.getByText(/Nothing scheduled in the next 45 days/)).toBeTruthy())
  })
})
