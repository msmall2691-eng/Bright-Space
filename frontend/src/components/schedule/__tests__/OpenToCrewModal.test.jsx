/**
 * Price before post. The bulk "Open to crew" action used to fire immediately
 * with no rate, so jobs landed on the bench's phones reading "No price set".
 * It now opens this modal, which ASKS for the rate first. These pin that the
 * ask happens and that what the office types reaches the caller.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

// The modal reads the "default pay %" rule when it opens (BB-CLAIM-04). Default
// the mock to no rule configured, so the existing "sub names it" copy holds.
vi.mock('../../../api', () => ({ get: vi.fn(() => Promise.resolve({ rules: [] })) }))
import { get } from '../../../api'
import { OpenToCrewModal } from '../PowerToolModals'

beforeEach(() => { get.mockReset(); get.mockResolvedValue({ rules: [] }) })
afterEach(cleanup)

const two = [{ job_id: 1 }, { job_id: 2 }]

const withDefaultPct = (pct) => get.mockResolvedValue({
  rules: [{ key: 'claim_default_pay',
            fields: [{ key: 'claim_default_pay_pct', value: pct }] }],
})

it('asks for a rate and passes the number entered', () => {
  const onConfirm = vi.fn()
  render(<OpenToCrewModal state={{ targets: two }} onCancel={() => {}} onConfirm={onConfirm} />)
  // The rate box is the whole point — the bulk path used to skip it entirely.
  fireEvent.change(screen.getByPlaceholderText('e.g. 120'), { target: { value: '120' } })
  fireEvent.click(screen.getByRole('button', { name: /on the board/i }))
  expect(onConfirm).toHaveBeenCalledWith(120)
})

it('a blank rate posts unpriced (null), for a sub to name their own', () => {
  const onConfirm = vi.fn()
  render(<OpenToCrewModal state={{ targets: [{ job_id: 9 }] }} onCancel={() => {}} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: /on the board/i }))
  expect(onConfirm).toHaveBeenCalledWith(null)
})

it('with no default set, tells the office a sub names their own price', async () => {
  render(<OpenToCrewModal state={{ targets: two }} onCancel={() => {}} onConfirm={() => {}} />)
  expect(await screen.findByText(/a sub names their own price/i)).toBeTruthy()
})

it('with a default pay % set, says a blank box is priced from the job (BB-CLAIM-04)', async () => {
  withDefaultPct(55)
  render(<OpenToCrewModal state={{ targets: two }} onCancel={() => {}} onConfirm={() => {}} />)
  // The blank-box meaning changed: it is now offered at the default, not left
  // for the sub to name — and the copy has to say the true thing.
  await waitFor(() => expect(screen.getByText(/55% of what it bills/i)).toBeTruthy())
  expect(screen.queryByText(/a sub names their own price/i)).toBeNull()
})

it('renders nothing when there is no batch to post', () => {
  const { container } = render(
    <OpenToCrewModal state={null} onCancel={() => {}} onConfirm={() => {}} />)
  expect(container.firstChild).toBeNull()
})
