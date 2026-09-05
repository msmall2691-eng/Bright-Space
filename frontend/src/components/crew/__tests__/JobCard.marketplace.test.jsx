/**
 * The crew's side of the marketplace (migration 097).
 *
 * An open job used to say "Claim this job — first come, first served", and
 * that promise is now false: several subs can want the same job and the
 * office picks. A button that claims to hand you the job and then doesn't is
 * worse than one that says what it does, so what's pinned here is that the
 * card describes the real mechanism — including to the person who already
 * asked, who otherwise sees a button that looks like it never worked.
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

it('asks for the job rather than promising it', async () => {
  show(OPEN_JOB)
  expect(screen.getByRole('button', { name: /Ask for this job/ })).toBeTruthy()
  expect(screen.getByText(/The office picks who gets it/)).toBeTruthy()
  // The old promise must not survive anywhere on the card.
  expect(screen.queryByText(/first come/i)).toBeNull()
  expect(screen.queryByRole('button', { name: /Claim this job/ })).toBeNull()
})

it('shows what the job pays, so an ask can be priced against it', () => {
  show(OPEN_JOB)
  expect(screen.getByText('$80')).toBeTruthy()
})

it('shows a standing request instead of a button that looks unpressed', () => {
  // Without this, a sub who already asked sees the same "Ask for this job"
  // button and taps it again wondering why nothing happened.
  show({ ...OPEN_JOB, my_claim_request: { status: 'pending', requested_rate: 95, message: null } })
  expect(screen.getByText(/You asked for \$95 — waiting to hear back/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Ask for this job/ })).toBeNull()
  // Still changeable — they can raise or drop their number.
  expect(screen.getByRole('button', { name: /Change what I asked for/ })).toBeTruthy()
})

it('says "you asked" without a number when they took the posted rate', () => {
  show({ ...OPEN_JOB, my_claim_request: { status: 'pending', requested_rate: null, message: null } })
  expect(screen.getByText(/You asked — waiting to hear back/)).toBeTruthy()
})

it('a declined ask can be made again', () => {
  // Not a dead end: the office may have picked someone who then fell through.
  show({ ...OPEN_JOB, my_claim_request: { status: 'declined', requested_rate: 95, message: null } })
  expect(screen.getByRole('button', { name: /Ask for this job/ })).toBeTruthy()
})

it('still offers to ask when the office set no price', () => {
  // The sheet is where they name their own number; the card must not hide
  // the way in just because there's nothing to show.
  show({ ...OPEN_JOB, posted_rate: null })
  expect(screen.getByRole('button', { name: /Ask for this job/ })).toBeTruthy()
  expect(screen.queryByText(/Pays/)).toBeNull()
})

it('opens the sheet when asked', () => {
  const onClaim = vi.fn()
  show(OPEN_JOB, { onClaim })
  fireEvent.click(screen.getByRole('button', { name: /Ask for this job/ }))
  expect(onClaim).toHaveBeenCalled()
})
