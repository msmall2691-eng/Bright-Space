/**
 * The office's side of the marketplace.
 *
 * #758 shipped the three endpoints with no UI, so a sub could file a request
 * and it would sit in the database unseen. What's pinned here is the decision
 * this screen exists for — who gets the job — and the two things that make it
 * decidable: a counter-offer readable against the asking price, and the
 * server's own refusal surfacing instead of a generic error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a), info: vi.fn() },
}))

import { get, post } from '../../../api'
import JobClaimRequests from '../JobClaimRequests'

const REQS = {
  job_id: 5, posted_rate: 80,
  requests: [
    { id: 1, cleaner_id: 'CT-1', cleaner_name: 'Dana', requested_rate: null,
      message: null, status: 'pending' },
    { id: 2, cleaner_id: 'CT-2', cleaner_name: 'Rob', requested_rate: 95,
      message: 'I bring my own supplies', status: 'pending' },
  ],
}

const mount = (payload = REQS, props = {}) => {
  get.mockResolvedValue(payload)
  return render(<JobClaimRequests jobId={5} postedRate={payload.posted_rate} {...props} />)
}

beforeEach(() => { get.mockReset(); post.mockReset(); toastError.mockReset(); toastSuccess.mockReset() })
afterEach(cleanup)

it('shows a counter-offer against the asking price, not as a bare number', async () => {
  mount()
  expect(await screen.findByText('Rob')).toBeTruthy()
  // Rob countered: his number AND what she asked, so the gap is the story.
  expect(screen.getByText('$95')).toBeTruthy()
  expect(screen.getByText(/you asked \$80/)).toBeTruthy()
  // Dana didn't counter — that reads as words, not an empty cell.
  expect(screen.getByText(/your asking price/)).toBeTruthy()
})

it('approves through the endpoint and tells the parent the job changed', async () => {
  // Approving assigns the job and closes the offer, so the page around this
  // panel is stale in ways the panel can't fix alone.
  const onDecided = vi.fn()
  post.mockResolvedValue({ status: 'approved', agreed_rate: 95 })
  mount(REQS, { onDecided })
  await screen.findByText('Rob')

  fireEvent.click(screen.getAllByRole('button', { name: /Give it to them/ })[1])
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/jobs/5/claim-requests/2/approve', {}))
  await waitFor(() => expect(onDecided).toHaveBeenCalled())
  expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('$95'))
})

it('declining one person does not disturb the rest of the job', async () => {
  const onDecided = vi.fn()
  post.mockResolvedValue({ status: 'declined' })
  mount(REQS, { onDecided })
  await screen.findByText('Dana')

  fireEvent.click(screen.getAllByRole('button', { name: /Decline/ })[0])
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/jobs/5/claim-requests/1/decline', {}))
  // No assignment happened, so nothing above needs refetching.
  expect(onDecided).not.toHaveBeenCalled()
})

it('passes the server’s own refusal through', async () => {
  // The server names the real blocker — already double-booked that morning,
  // no rate agreed, someone else got there first. "Could not approve" throws
  // away the only sentence that tells her what to do next.
  post.mockRejectedValue({ detail: 'Conflict: Rob is already booked 9:00–12:00' })
  mount()
  await screen.findByText('Rob')
  fireEvent.click(screen.getAllByRole('button', { name: /Give it to them/ })[1])
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(
    'Conflict: Rob is already booked 9:00–12:00'))
})

it('says picking one turns the others down, when there are others', async () => {
  mount()
  expect(await screen.findByText(/turns the others down/)).toBeTruthy()
  cleanup()
  mount({ ...REQS, requests: [REQS.requests[0]] })
  await screen.findByText('Dana')
  expect(screen.queryByText(/turns the others down/)).toBeNull()
})

it('tells her to set a price when a posted job has none', async () => {
  // The crew app refuses a request against a job with no number on it, so an
  // empty board is a thing she can fix rather than a mystery.
  mount({ job_id: 5, posted_rate: null, requests: [] })
  expect(await screen.findByText(/set a rate so they know what it pays/)).toBeTruthy()
})

it('says nothing changed when the list cannot be loaded', async () => {
  get.mockRejectedValue(new Error('offline'))
  render(<JobClaimRequests jobId={5} postedRate={80} />)
  expect(await screen.findByText(/Nothing has changed/)).toBeTruthy()
})
