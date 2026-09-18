/**
 * "Needs a date" — date-less jobs on the Schedule page.
 *
 * The week/month query is date-bounded, so a job with no scheduled_date (a
 * quote accepted, day not picked yet) never appeared anywhere on the page.
 * Pinned: the strip lists them by client with a Schedule action, counts as a
 * plain number (no bubble), and renders nothing when the list is empty.
 */
import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NeedsDateStrip from '../NeedsDateStrip'

afterEach(cleanup)

const show = (jobs, onSchedule = vi.fn()) => {
  render(<MemoryRouter><NeedsDateStrip jobs={jobs} onSchedule={onSchedule} /></MemoryRouter>)
  return onSchedule
}

it('renders nothing when every job has a date', () => {
  show([])
  expect(screen.queryByTestId('needs-date-strip')).toBeNull()
})

it('lists date-less jobs by client with a Schedule action', () => {
  const onSchedule = show([
    { id: 11, client_name: 'Megan Q', property_name: 'Gap House', quote_id: 7 },
    { id: 12, client_name: 'Ira I', title: 'Deep clean' },
  ])
  expect(screen.getByText('Needs a date')).toBeTruthy()
  expect(screen.getByText('2')).toBeTruthy()
  expect(screen.getByText('Megan Q').closest('a').getAttribute('href')).toBe('/jobs/11')
  expect(screen.getByText(/Gap House · from quote/)).toBeTruthy()
  fireEvent.click(screen.getAllByText('Schedule')[0])
  expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }))
})

it('caps the list and says how many more', () => {
  show([1, 2, 3, 4, 5, 6].map(i => ({ id: i, client_name: `C${i}` })))
  expect(screen.getAllByText('Schedule')).toHaveLength(4)
  expect(screen.getByText('and 2 more')).toBeTruthy()
})
