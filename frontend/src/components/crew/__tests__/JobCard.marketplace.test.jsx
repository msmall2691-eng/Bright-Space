/**
 * The crew's side of the marketplace.
 *
 * The card leads with a one-tap ACCEPT at the posted price ("Take it · $X") —
 * bidding a different price is a quiet secondary link ("Ask for a different
 * price"), not the first thing a cleaner faces. Whether an accept is INSTANT
 * ("it's yours, first to accept wins") or files a request the office approves
 * depends on the office's setting — instant claiming is OFF by default (owner's
 * call, Sept 2026). The backend sends `instant_claim` per job, so the caption
 * tells the truth either way instead of promising instant and handing back a
 * pending request.
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
// Priced, but instant claiming is OFF (the default) — an accept files a request.
const ASK_JOB = { ...INSTANT_JOB, instant_claim: false }

const show = (job, props = {}) => render(
  <MemoryRouter><JobCard job={job} onClaim={() => {}} onAccept={() => {}} {...props} /></MemoryRouter>)

it('leads with one-tap "Take it" at the posted price — bidding is secondary', () => {
  show(ASK_JOB)
  expect(screen.getByRole('button', { name: /Take it · \$80/ })).toBeTruthy()
  // Bidding a different price is a quiet last-resort link, not the main action.
  expect(screen.getByRole('button', { name: /Ask for a different price/ })).toBeTruthy()
  // The old bid-first framing is gone.
  expect(screen.queryByRole('button', { name: /^Ask for this job/ })).toBeNull()
})

it('when instant claiming is on, taking it is yours outright', () => {
  show(INSTANT_JOB)
  expect(screen.getByRole('button', { name: /Take it · \$80/ })).toBeTruthy()
  expect(screen.getByText(/first to accept gets it/i)).toBeTruthy()
})

it('when instant claiming is off, taking it still routes to the office — no false "it\'s yours"', () => {
  show(ASK_JOB)
  expect(screen.getByText(/office confirms who gets it/i)).toBeTruthy()
  expect(screen.queryByText(/first to accept gets it/i)).toBeNull()
})

it('shows what the job pays, so an accept is priced against it', () => {
  show(ASK_JOB)
  expect(screen.getByText(/Pays/)).toBeTruthy()
  // The price is on the primary button too.
  expect(screen.getByRole('button', { name: /Take it · \$80/ })).toBeTruthy()
})

it('shows a standing request instead of an unpressed button', () => {
  show({ ...INSTANT_JOB, my_claim_request: { status: 'pending', requested_rate: 95, message: null } })
  expect(screen.getByText(/You offered \$95 — waiting on the office/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Take it/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Change my offer/ })).toBeTruthy()
})

it('a declined request can be acted on again', () => {
  // Not a dead end: the office may have picked someone who then fell through.
  show({ ...INSTANT_JOB, my_claim_request: { status: 'declined', requested_rate: 95, message: null } })
  expect(screen.getByRole('button', { name: /Take it · \$80/ })).toBeTruthy()
})

it('a rate-less job becomes an offer the office prices, said on the card', () => {
  // No posted price is no anchor for an accept, so it's an offer — bidding is
  // unavoidable here, which is fine.
  show({ ...INSTANT_JOB, posted_rate: null, instant_claim: false })
  expect(screen.getByText(/No price set — name yours and the office will confirm/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Make an offer/ })).toBeTruthy()
  expect(screen.queryByText(/Pays/)).toBeNull()
})

it('the primary button ACCEPTS (onAccept); the secondary link BIDS (onClaim)', () => {
  const onAccept = vi.fn()
  const onClaim = vi.fn()
  show(ASK_JOB, { onAccept, onClaim })
  fireEvent.click(screen.getByRole('button', { name: /Take it · \$80/ }))
  expect(onAccept).toHaveBeenCalled()
  expect(onClaim).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Ask for a different price/ }))
  expect(onClaim).toHaveBeenCalled()
})

it('a rate-less job\'s "Make an offer" opens the bid sheet (onClaim)', () => {
  const onClaim = vi.fn()
  show({ ...ASK_JOB, posted_rate: null }, { onClaim })
  fireEvent.click(screen.getByRole('button', { name: /Make an offer/ }))
  expect(onClaim).toHaveBeenCalled()
})
