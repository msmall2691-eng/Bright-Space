/**
 * The crew's side of the marketplace — Turno-style (owner's call, Sept 2026).
 *
 * Claiming a posted job at the posted price makes it YOURS on the spot: first
 * to claim wins, no office step. So the card says "Claim this job" and means
 * it. The one case that still waits is a bid ABOVE the posted price, and only
 * then does the card talk about the office confirming. What's pinned here is
 * that the card describes the real mechanism — claim vs offer — including to
 * the person whose above-posted offer is standing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import JobCard from '../JobCard'

afterEach(cleanup)

const OPEN_JOB = {
  id: 7, title: 'Deep clean', property_name: '12 Pine',
  scheduled_date: '2026-09-10', start_time: '09:00', end_time: '12:00',
  status: 'scheduled', open: true, posted_rate: 80, my_claim_request: null,
}

const show = (job, props = {}) => render(
  <MemoryRouter><JobCard job={job} onClaim={() => {}} {...props} /></MemoryRouter>)

it('offers to claim a posted job outright, first come first served', () => {
  show(OPEN_JOB)
  expect(screen.getByRole('button', { name: /Claim this job/ })).toBeTruthy()
  expect(screen.getByText(/first to claim gets it/i)).toBeTruthy()
  // The old "the office picks / ask" framing must not survive.
  expect(screen.queryByText(/office picks who gets it/i)).toBeNull()
  expect(screen.queryByRole('button', { name: /Ask for this job/ })).toBeNull()
})

it('shows what the job pays, so a claim is priced against it', () => {
  show(OPEN_JOB)
  expect(screen.getByText('$80')).toBeTruthy()
})

it('shows a standing OFFER (above posted) instead of an unpressed button', () => {
  // A pending request only exists for a bid above the posted price now — an
  // at-or-below claim is instant, so it never sits pending.
  show({ ...OPEN_JOB, my_claim_request: { status: 'pending', requested_rate: 95, message: null } })
  expect(screen.getByText(/You offered \$95 — waiting on the office/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Claim this job/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Change my offer/ })).toBeTruthy()
})

it('a declined ask can be claimed again', () => {
  // Not a dead end: the office may have picked someone who then fell through.
  show({ ...OPEN_JOB, my_claim_request: { status: 'declined', requested_rate: 95, message: null } })
  expect(screen.getByRole('button', { name: /Claim this job/ })).toBeTruthy()
})

it('a rate-less job becomes an offer the office prices, said on the card', () => {
  // No posted price is no anchor for an instant claim, so it's an offer. Say
  // so up front instead of letting a blank field 422 at the server.
  show({ ...OPEN_JOB, posted_rate: null })
  expect(screen.getByText(/No price set — name yours and the office will confirm/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Make an offer/ })).toBeTruthy()
  expect(screen.queryByText(/Pays/)).toBeNull()
})

it('opens the sheet when claimed', () => {
  const onClaim = vi.fn()
  show(OPEN_JOB, { onClaim })
  fireEvent.click(screen.getByRole('button', { name: /Claim this job/ }))
  expect(onClaim).toHaveBeenCalled()
})
