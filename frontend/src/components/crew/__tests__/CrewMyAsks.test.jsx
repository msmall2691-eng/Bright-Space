/**
 * My asks — the sub's side of the ledger, and the withdraw that was missing.
 * Once the office picks, a job leaves the board; without this the request just
 * vanished. These pin that each ask shows with its status, that a pending ask
 * can be pulled back, and that a decided one cannot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { get, post } from '../../../api'
import CrewMyAsks from '../CrewMyAsks'

const CLAIMS = [
  { job_id: 1, status: 'pending', area: 'Saco ME', requested_rate: 95, scheduled_date: '2026-09-12' },
  { job_id: 2, status: 'approved', area: 'Scarborough ME', agreed_rate: 140, scheduled_date: '2026-09-13' },
  { job_id: 3, status: 'declined', area: 'Biddeford ME', posted_rate: 80, scheduled_date: '2026-09-10' },
]

beforeEach(() => { get.mockReset(); post.mockReset() })
afterEach(cleanup)

it('lists each ask with what happened to it', async () => {
  get.mockResolvedValue({ claims: CLAIMS })
  render(<CrewMyAsks />)
  await screen.findByText('Waiting to hear')
  expect(screen.getByText('You got it')).toBeTruthy()
  expect(screen.getByText('Someone else got it')).toBeTruthy()
})

it('lets a sub withdraw a pending ask and only a pending one', async () => {
  get.mockResolvedValue({ claims: CLAIMS })
  post.mockResolvedValue({ job_id: 1, status: 'withdrawn' })
  render(<CrewMyAsks />)
  await screen.findByText('Waiting to hear')
  // Exactly one Withdraw button — the pending row. The won and lost rows have none.
  const buttons = screen.getAllByRole('button', { name: /withdraw/i })
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/crew/jobs/1/claim/withdraw', {}))
})

it('says so plainly when the sub has asked for nothing', async () => {
  get.mockResolvedValue({ claims: [] })
  render(<CrewMyAsks />)
  await screen.findByText(/haven't asked for any jobs/i)
})

it('reads the office preview twin, and withdrawing is inert there', async () => {
  get.mockResolvedValue({ claims: CLAIMS })
  render(<CrewMyAsks previewUserId={42} />)
  await screen.findByText('Waiting to hear')
  // Office preview reads the read-only twin for the NAMED cleaner…
  expect(get).toHaveBeenCalledWith('/api/crew/preview/42/my-claims')
  // …and the withdraw is the cleaner's own — a tap posts nothing.
  const buttons = screen.getAllByRole('button', { name: /withdraw/i })
  fireEvent.click(buttons[0])
  await waitFor(() => expect(post).not.toHaveBeenCalled())
})
