/**
 * The crew's side of the marketplace.
 *
 * Whether claiming a posted job is INSTANT ("it's yours, first to claim wins")
 * or an ASK the office approves depends on the office's setting — instant
 * claiming is OFF by default (owner's call, Sept 2026: switched off until the
 * bench's documents are all in). The backend sends `instant_claim` per job, so
 * the card tells the truth either way instead of promising instant and handing
 * back a pending request. What's pinned here is that the card's copy follows
 * that flag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import JobCard from '../JobCard'

afterEach(cleanup)

// Priced, and the office has instant claiming ON.
const INSTANT_JOB = {
  id: 7, title: 'Deep clean', property_name: '12 Pine',
  scheduled_date: '2026-09-10', start_time: '09:00', end_time: '12:00',
  status: 'scheduled', open: true, posted_rate: 80, instant_claim: true,
  my_claim_request: null,
}
// Priced, but instant claiming is OFF (the default) — a claim is an ask.
const ASK_JOB = { ...INSTANT_JOB, instant_claim: false }

const show = (job, props = {}) => render(
  <MemoryRouter><JobCard job={job} onClaim={() => {}} {...props} /></MemoryRouter>)

it('claims a posted job outright when instant claiming is on', () => {
  show(INSTANT_JOB)
  expect(screen.getByRole('button', { name: /Claim this job/ })).toBeTruthy()
  expect(screen.getByText(/first to claim gets it/i)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Ask for this job/ })).toBeNull()
})

it('asks the office when instant claiming is off — no false "it\'s yours"', () => {
  show(ASK_JOB)
  expect(screen.getByRole('button', { name: /Ask for this job/ })).toBeTruthy()
  expect(screen.getByText(/office confirms who gets it/i)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Claim this job/ })).toBeNull()
  expect(screen.queryByText(/first to claim gets it/i)).toBeNull()
})

it('shows what the job pays either way, so a claim is priced against it', () => {
  show(ASK_JOB)
  expect(screen.getByText('$80')).toBeTruthy()
})

it('shows a standing request instead of an unpressed button', () => {
  show({ ...INSTANT_JOB, my_claim_request: { status: 'pending', requested_rate: 95, message: null } })
  expect(screen.getByText(/You offered \$95 — waiting on the office/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Claim this job/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Change my offer/ })).toBeTruthy()
})

it('a declined request can be acted on again', () => {
  // Not a dead end: the office may have picked someone who then fell through.
  show({ ...INSTANT_JOB, my_claim_request: { status: 'declined', requested_rate: 95, message: null } })
  expect(screen.getByRole('button', { name: /Claim this job/ })).toBeTruthy()
})

it('a rate-less job becomes an offer the office prices, said on the card', () => {
  // No posted price is no anchor for an instant claim, so it's an offer.
  show({ ...INSTANT_JOB, posted_rate: null, instant_claim: false })
  expect(screen.getByText(/No price set — name yours and the office will confirm/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Make an offer/ })).toBeTruthy()
  expect(screen.queryByText(/Pays/)).toBeNull()
})

it('opens the sheet when the claim/ask button is pressed', () => {
  const onClaim = vi.fn()
  show(ASK_JOB, { onClaim })
  fireEvent.click(screen.getByRole('button', { name: /Ask for this job/ }))
  expect(onClaim).toHaveBeenCalled()
})
