/**
 * Bringing your own helper — migration 107, and one of the five Maine criteria
 * rather than a convenience.
 *
 * Part 1 #4 of Maine's unified employment standard is "hires, pays and
 * supervises their own assistants, if any", and all five of Part 1 must hold.
 * The app modelled one cleaner per job, so there was nowhere to say it.
 *
 * What the card must get right is mostly WHERE it appears and WHAT IT PROMISES:
 * you don't staff a job you haven't won, and the rate doesn't move.
 */
import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import JobCard from '../JobCard'

afterEach(cleanup)

const MINE = {
  id: 1, title: 'Deep clean', property_name: 'Harbour St', status: 'scheduled',
  scheduled_date: '2026-09-10', job_type: 'residential', open: false,
  my_helpers: [], house_notes: [],
}

const show = (job, props = {}) => render(<JobCard job={job} {...props} />)

it('offers to add someone, and says the pay does not change', () => {
  show(MINE, { onHelpers: vi.fn() })
  // The rate line is the point: a sub whose first thought is "does this cost
  // me?" gets the honest answer before they tap, and the honest answer is what
  // makes this their assistant rather than the company's.
  expect(screen.getByText(/you're paid the same|you’re paid the same/i)).toBeTruthy()
})

it('names who you already said you are bringing', () => {
  show({ ...MINE, my_helpers: [{ id: 7, name: 'Sam Reed' }] }, { onHelpers: vi.fn() })
  expect(screen.getByText(/Bringing Sam Reed/)).toBeTruthy()
})

it('never offers it on the open-jobs board', () => {
  // You don't staff a job you haven't got. An offer is an offer.
  show({ ...MINE, open: true, posted_rate: 90 }, { onHelpers: vi.fn(), onClaim: vi.fn() })
  expect(screen.queryByText(/Bringing someone/i)).toBeNull()
})

it('never offers it on a finished job', () => {
  show({ ...MINE, status: 'completed' }, { onHelpers: vi.fn() })
  expect(screen.queryByText(/Bringing someone/i)).toBeNull()
})

it('stays out of the way when the page does not offer it', () => {
  const { container } = show(MINE)
  expect(container.textContent).not.toMatch(/Bringing/i)
})
