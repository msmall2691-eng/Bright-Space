/**
 * Direct deposit, from the sub's side.
 *
 * The point of the integration is that the sensitive part happens on Stripe's
 * page rather than in this app, so what's pinned here is mostly what the
 * screen PROMISES and what it refuses to become:
 *
 *   - it says the SSN never comes here, because that is the actual reason the
 *     integration exists;
 *   - it says skipping it changes nothing about the work you can ask for,
 *     because "open an account or you're not eligible" is a condition of
 *     engagement this arrangement must not have;
 *   - unconfigured, it explains itself instead of offering a dead button.
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))
import { get, post } from '../../../api'
import CrewPayoutSetup from '../CrewPayoutSetup'

beforeEach(() => { get.mockReset(); post.mockReset() })
afterEach(cleanup)

const mount = (state) => { get.mockResolvedValue(state); return render(<CrewPayoutSetup />) }

it('offers setup, and says the SSN never comes here', async () => {
  mount({ available: true, connected: false, payouts_enabled: false })
  expect(await screen.findByRole('button', { name: /set up direct deposit/i })).toBeTruthy()
  expect(screen.getByText(/never see your Social Security number/i)).toBeTruthy()
})

it('says out loud that skipping it costs you nothing', async () => {
  // The restraint that keeps this from becoming a condition of engagement.
  mount({ available: true, connected: false, payouts_enabled: false })
  await screen.findByRole('button', { name: /set up direct deposit/i })
  expect(screen.getByText(/won’t affect the jobs you can ask for/i)).toBeTruthy()
})

it('explains itself when the office has not switched it on', async () => {
  // Not a dead button, and not an error.
  mount({ available: false, connected: false })
  expect(await screen.findByText(/isn’t switched on yet/i)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('says what Stripe is still waiting for when setup is half done', async () => {
  mount({ available: true, connected: true, payouts_enabled: false,
          needs: 'individual.dob.day' })
  expect(await screen.findByText(/still needs a bit more/i)).toBeTruthy()
  expect(screen.getByText(/individual.dob.day/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /finish setting it up/i })).toBeTruthy()
})

it('confirms plainly once payouts are live', async () => {
  mount({ available: true, connected: true, payouts_enabled: true })
  expect(await screen.findByText(/straight to your bank/i)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('surfaces the server’s own refusal rather than a generic error', async () => {
  mount({ available: true, connected: false, payouts_enabled: false })
  post.mockRejectedValue({ detail: 'Couldn’t reach Stripe just now.' })
  fireEvent.click(await screen.findByRole('button', { name: /set up direct deposit/i }))
  await waitFor(() => expect(screen.getByText(/Couldn’t reach Stripe just now/)).toBeTruthy())
})

it('says it in dots and words, never a tinted banner', async () => {
  const { container } = mount({ available: true, connected: true, payouts_enabled: false,
                                needs: 'individual.dob.day' })
  await screen.findByText(/still needs a bit more/i)
  expect(container.innerHTML).not.toMatch(/\bbg-\w+-(50|100|200)(?!\d)/)
  expect(container.querySelectorAll('.w-1\\.5.h-1\\.5.rounded-full').length).toBeGreaterThan(0)
})
