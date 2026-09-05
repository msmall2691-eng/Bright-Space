/**
 * The office's side of a subcontractor's file.
 *
 * Two things carry the weight here. It reads the SAME vetting status the
 * crew's "My file" reads, so the two screens can't drift into disagreeing
 * about whether somebody is cleared to work — the office's answer is what
 * stops an uninsured person walking into a customer's house. And it fetches
 * NOTHING until opened: the staff list renders every user at once, so a panel
 * that loaded on mount would fire one request per cleaner just to draw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { get, post } from '../../api'
import SubFileReview from '../SubFileReview'

const FILE = {
  can_take_jobs: false,
  missing: ['Certificate of insurance is waiting for the office to review it'],
  agreement_version: '2026-09', agreement_accepted: true,
  documents: [
    { kind: 'w9', label: 'W-9', required: true, expires: false,
      status: 'accepted', expires_at: null, notes: null },
    { kind: 'coi', label: 'Certificate of insurance', required: true, expires: true,
      status: 'pending', expires_at: '2027-01-31', notes: null },
  ],
}

beforeEach(() => { get.mockReset(); post.mockReset(); get.mockResolvedValue(FILE); post.mockResolvedValue(FILE) })
afterEach(cleanup)

it('fetches nothing until it is opened', async () => {
  render(<SubFileReview userId={7} />)
  expect(get).not.toHaveBeenCalled()          // fifteen cleaners, zero requests

  fireEvent.click(screen.getByRole('button', { name: /Subcontractor file/ }))
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/auth/users/7/file'))
})

const open = async () => {
  render(<SubFileReview userId={7} />)
  fireEvent.click(screen.getByRole('button', { name: /Subcontractor file/ }))
  return screen.findByText('W-9')
}

it('says whether this person is cleared to work', async () => {
  await open()
  expect(screen.getByText(/1 thing outstanding/)).toBeTruthy()
  cleanup()

  get.mockResolvedValue({ ...FILE, can_take_jobs: true, missing: [] })
  await open()
  expect(screen.getByText(/Cleared to take jobs/)).toBeTruthy()
})

it('accepts a document and takes the refreshed file back', async () => {
  await open()
  fireEvent.click(screen.getAllByRole('button', { name: /Accept/ })[0])
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/auth/users/7/file/coi/review', { status: 'accepted' }))
  // One call for the decision — the POST returns the whole file.
  expect(get).toHaveBeenCalledTimes(1)
})

it('sending a document back carries the reason', async () => {
  // A rejection with no reason is a dead end for whoever has to fix it.
  vi.stubGlobal('prompt', () => 'The expiry date is cut off')
  await open()
  fireEvent.click(screen.getAllByRole('button', { name: /Send back/ })[0])
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/auth/users/7/file/w9/review',
    { status: 'pending', notes: 'The expiry date is cut off' }))
})

it('cancelling the reason prompt changes nothing', async () => {
  vi.stubGlobal('prompt', () => null)
  await open()
  fireEvent.click(screen.getAllByRole('button', { name: /Send back/ })[0])
  expect(post).not.toHaveBeenCalled()
})

it('an already-accepted document offers no second Accept', async () => {
  await open()
  // W-9 is accepted; only the pending COI should offer it.
  expect(screen.getAllByRole('button', { name: /Accept/ })).toHaveLength(1)
})

it('links to the document itself rather than making her guess', async () => {
  await open()
  const link = screen.getAllByRole('link', { name: /View/ })[0]
  expect(link.getAttribute('href')).toBe('/api/auth/users/7/file/w9/download')
  expect(link.getAttribute('target')).toBe('_blank')
})
