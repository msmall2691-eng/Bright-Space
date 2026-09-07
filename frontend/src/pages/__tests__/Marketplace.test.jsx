/**
 * The Marketplace hub.
 *
 * It exists because the bench shipped as five surfaces bolted onto other
 * pages and the owner's first question about it was where to find it. So the
 * things worth pinning are about it staying a hub:
 *
 *   * ONE request draws the page. A gathering screen that costs four round
 *     trips is worse than the five pages it gathers;
 *   * it never approves anything. Answering a claim request is the one path
 *     where "a sub requests, the office never assigns" is enforced, and a
 *     second implementation is a second place to get classification wrong —
 *     so every row LINKS to the screen that owns the action;
 *   * "waiting on you" comes first and is honest when it is empty, because a
 *     hub that always looks busy is one you stop reading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn() }))

import { get } from '../../api'
import Marketplace from '../Marketplace'

const payload = (over = {}) => ({
  today: '2026-03-10',
  waiting: {
    applications: [{ id: 3, name: 'Sam Vetter', towns: 'Rockland, Camden',
                     created_at: '2026-03-09T12:00:00' }],
    application_count: 1,
    jobs: [{ job_id: 91, title: 'Weekly clean', client: 'The Bergs', town: 'Rockport',
             scheduled_date: '2026-03-12', posted_rate: 140, asked: 2 }],
    job_count: 1,
    people_waiting: 2,
  },
  open_jobs: [
    { job_id: 91, title: 'Weekly clean', client: 'The Bergs', town: 'Rockport',
      scheduled_date: '2026-03-12', posted_rate: 140, asked: 2 },
    { job_id: 92, title: 'Turnover', client: 'Shore House', town: 'Owls Head',
      scheduled_date: '2026-03-14', posted_rate: 95, asked: 0 },
  ],
  open_job_count: 2,
  bench: { people: 6, can_work: 4, awaiting_review: 1, blocked: 1, direct_deposit: 2 },
  money: { owed: 420, paid_ytd: 8150.5, year: 2026 },
  ...over,
})

const show = async (over) => {
  get.mockResolvedValue(payload(over))
  render(<MemoryRouter><Marketplace /></MemoryRouter>)
  await screen.findByText('Waiting on you')
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

// ── It stays a hub ──────────────────────────────────────────────────────────

it('draws the whole page from one request', async () => {
  await show()
  // Four sections' worth of state. A hub that costs four round trips to draw
  // is worse than the five pages it replaces.
  expect(get).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenCalledWith('/api/marketplace')
})

it('sends you to the job to answer a request, and never answers one itself', async () => {
  await show()
  const row = screen.getByText(/asked for/).closest('a')
  expect(row.getAttribute('href')).toBe('/jobs/91')
  // No approve/decline anywhere on this page. That path is enforced in one
  // place on purpose — a sub requests, the office never assigns.
  expect(screen.queryByRole('button', { name: /approve|decline|accept/i })).toBeNull()
})

it('sends you to Crew to decide on an applicant', async () => {
  await show()
  expect(screen.getByText('Sam Vetter').closest('a').getAttribute('href')).toBe('/crew')
})

// ── Waiting on you ──────────────────────────────────────────────────────────

it('leads with the people who are blocked on you', async () => {
  await show()
  const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
  expect(headings[0]).toMatch(/Waiting on you/)
  // One applicant plus two people holding a request = three things blocked on
  // the office. A plain number beside the heading, never a red bubble.
  expect(headings[0]).toMatch(/3/)
  expect(screen.getAllByText(/2 people/).length).toBeGreaterThan(0)
})

it('says plainly when nobody is waiting, rather than looking busy', async () => {
  await show({ waiting: { applications: [], application_count: 0, jobs: [],
                          job_count: 0, people_waiting: 0 } })
  // A hub that always looks like it has work on it is one you stop reading.
  expect(screen.getByText(/Nobody’s waiting on an answer/)).toBeTruthy()
})

// ── The bench and the money ─────────────────────────────────────────────────

it('shows how much of the bench can actually take work', async () => {
  await show()
  expect(screen.getByText(/of 6 cleared to work/)).toBeTruthy()
  expect(screen.getByText(/can’t take jobs/)).toBeTruthy()
})

it('keeps owed and paid apart, because sent is not paid', async () => {
  await show()
  expect(screen.getByText('$420.00')).toBeTruthy()
  expect(screen.getByText('$8,150.50')).toBeTruthy()
  expect(screen.getByText(/Owed to subcontractors/)).toBeTruthy()
})

it('tells you an empty board is empty and how to fill it', async () => {
  await show({ open_jobs: [], open_job_count: 0 })
  expect(screen.getByText(/No jobs are open right now/)).toBeTruthy()
})

// ── The front door ──────────────────────────────────────────────────────────

it('hands you the public application link, which is the thing you share', async () => {
  await show()
  const link = screen.getByRole('link', { name: /\/apply$/ })
  // Built from the browser's own origin, so it can never show a stale domain.
  expect(link.getAttribute('href')).toBe('/apply')
  expect(link.textContent).toBe(`${window.location.origin}/apply`)
})

it('says what went wrong instead of an empty page', async () => {
  get.mockRejectedValue({ detail: 'Server is down' })
  render(<MemoryRouter><Marketplace /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Server is down')).toBeTruthy())
})
