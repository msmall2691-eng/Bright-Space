/**
 * My rentals — the standing-cleaner turnovers, grouped by house.
 *
 * Pins: turnovers group under their property; a "Yours" turnover opens the job
 * detail sheet (assigned, so the detail endpoint serves it); an "Offered to you"
 * turnover opens the CLAIM flow instead (the detail endpoint 404s a job that
 * isn't theirs yet, and taking it must go through request/approve — offered,
 * never assigned); and the empty state reads for a cleaner with no rentals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn() }))

import { get } from '../../../api'
import CrewMyProperties from '../CrewMyProperties'

const PAYLOAD = {
  properties: [
    {
      property_id: 10, name: '7 Dune Way', city: 'Portland', state: 'ME',
      upcoming_count: 2,
      turnovers: [
        { job_id: 101, date: '2026-10-05', start_time: '10:00', end_time: '13:00',
          status: 'scheduled', mine: false, claimable: true, posted_rate: 90, my_claim_request: null },
        { job_id: 102, date: '2026-10-09', start_time: '10:00', end_time: '13:00',
          status: 'scheduled', mine: true, claimable: false, posted_rate: 90, agreed_rate: 90, my_claim_request: null },
      ],
    },
  ],
}

beforeEach(() => { get.mockReset() })
afterEach(cleanup)

it('groups turnovers under the house and shows their state', async () => {
  get.mockResolvedValue(PAYLOAD)
  render(<CrewMyProperties />)
  await screen.findByText('7 Dune Way')
  expect(screen.getByText('Portland, ME')).toBeTruthy()
  expect(screen.getByText('Offered to you')).toBeTruthy()
  expect(screen.getByText('Yours')).toBeTruthy()
})

it('opens the detail sheet for a turnover already mine', async () => {
  get.mockResolvedValue(PAYLOAD)
  const onOpenJob = vi.fn()
  const onClaim = vi.fn()
  render(<CrewMyProperties onOpenJob={onOpenJob} onClaim={onClaim} />)
  await screen.findByText('7 Dune Way')
  fireEvent.click(screen.getByText('Yours').closest('button'))
  expect(onOpenJob).toHaveBeenCalledWith(102)
  expect(onClaim).not.toHaveBeenCalled()
})

it('opens the claim flow for a turnover still offered', async () => {
  get.mockResolvedValue(PAYLOAD)
  const onOpenJob = vi.fn()
  const onClaim = vi.fn()
  render(<CrewMyProperties onOpenJob={onOpenJob} onClaim={onClaim} />)
  await screen.findByText('7 Dune Way')
  fireEvent.click(screen.getByText('Offered to you').closest('button'))
  expect(onClaim).toHaveBeenCalledTimes(1)
  expect(onClaim.mock.calls[0][0]).toMatchObject({ id: 101, posted_rate: 90, property_name: '7 Dune Way' })
  expect(onOpenJob).not.toHaveBeenCalled()
})

it('shows an empty state for a cleaner with no rentals', async () => {
  get.mockResolvedValue({ properties: [] })
  render(<CrewMyProperties />)
  await screen.findByText('No rentals assigned to you.')
})
