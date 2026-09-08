/**
 * Paying subcontractors, from the office's side — the Stripe rail (part two).
 *
 * The button that used to hand over a CSV can now move real money, and which
 * of those it does depends on a setting. So what is pinned here is mostly that
 * the screen never lies about which one is about to happen:
 *
 *   * the verb changes with the rail — Pay when it settles, Send when it
 *     hands over a list. It is the only warning anyone gets;
 *   * a batch that half-worked reports every skipped person and why, on
 *     screen, not in a toast that is gone before you have read it;
 *   * a rail that cannot pay right now disables the button and says so,
 *     rather than failing after the click;
 *   * the 1099 sentence reads its threshold from the API. Typed into prose it
 *     was wrong for a year — the reporting threshold rose to $2,000 for
 *     payments made after 31 December 2025.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// Send/Pay now confirms first — it's the one action that moves money. Default
// the dialog to "yes" so the existing decision tests still exercise the POST;
// individual tests override it to check the prompt and the cancel path.
const confirmDialog = vi.fn(() => Promise.resolve(true))
vi.mock('../../../utils/confirmBus', () => ({ confirmDialog: (...a) => confirmDialog(...a) }))

import { get, post } from '../../../api'
import SubcontractorPayroll from '../SubcontractorPayroll'

const PAYOUT = {
  id: 1, user_id: 5, cleaner_id: 'CT-1', name: 'Dana Reed', job_id: 9,
  amount: 140, status: 'due', method: null, external_ref: null,
  memo: 'Weekly clean', earned_on: '2026-03-10', paid_at: null,
  direct_deposit: true,
}

const view = (over = {}) => ({
  period: '2026-03-01 to 2026-03-31',
  start_date: '2026-03-01', end_date: '2026-03-31',
  earned_total: 140, unrecorded: [], unrecorded_total: 0, unmatched: [],
  payouts: [PAYOUT],
  due_total: 140, outstanding_total: 140, paid_total: 0,
  ytd: { year: 2026, threshold: 2000, subs: [], total: 0, outstanding: 0 },
  rail: { name: 'manual', settles: false, ready: true, detail: null },
  rails: [{ name: 'manual', label: 'By hand, from a CSV', settles: false },
          { name: 'stripe', label: 'Stripe — straight to their bank', settles: true }],
  ...over,
})

const STRIPE = {
  rail: { name: 'stripe', settles: true, ready: true,
          detail: '$1,000.00 available to send' },
}

beforeEach(() => {
  get.mockReset(); post.mockReset()
  confirmDialog.mockReset(); confirmDialog.mockResolvedValue(true)
})
afterEach(cleanup)

async function show(over = {}) {
  get.mockResolvedValue(view(over))
  render(<SubcontractorPayroll startDate="2026-03-01" endDate="2026-03-31" isAdmin />)
  await screen.findByText('Ledger')
}

const selectTheRow = () =>
  fireEvent.click(screen.getByRole('checkbox', { name: /Select payout for Dana Reed/ }))

// ── The verb is the warning ─────────────────────────────────────────────────

it('says Send on a rail that only hands over a list', async () => {
  await show()
  selectTheRow()
  expect(screen.getByRole('button', { name: /^Send 1 · \$140\.00$/ })).toBeTruthy()
})

it('says Pay on a rail that actually moves the money', async () => {
  await show(STRIPE)
  selectTheRow()
  // The same button, one word different, and the difference is whether $140
  // leaves the business when it is pressed.
  expect(screen.getByRole('button', { name: /^Pay 1 · \$140\.00$/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Send 1/ })).toBeNull()
})

// ── A rail that cannot pay ──────────────────────────────────────────────────

it('will not let you press Pay when the rail is not set up', async () => {
  await show({ rail: { name: 'stripe', settles: true, ready: false,
                       detail: "Stripe isn't connected." } })
  selectTheRow()
  expect(screen.getByRole('button', { name: /^Pay 1/ }).disabled).toBe(true)
  expect(screen.getByText(/Stripe isn't connected/)).toBeTruthy()
})

it('shows what the rail can pay right now', async () => {
  await show(STRIPE)
  // The balance is the one number that decides whether pressing Pay does
  // anything, and nothing else in the app can tell you it.
  expect(screen.getByText(/\$1,000\.00 available to send/)).toBeTruthy()
})

// ── Choosing how people get paid ────────────────────────────────────────────

it('lets an admin change the rail, which nothing else in the app could do', async () => {
  await show()
  const picker = screen.getByLabelText('How subcontractors get paid')
  post.mockResolvedValue({ name: 'stripe', settles: true, ready: true })
  get.mockResolvedValue(view(STRIPE))

  fireEvent.change(picker, { target: { value: 'stripe' } })

  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/payroll/subcontractors/rail', { name: 'stripe' }))
})

it('does not offer the choice to someone who cannot make it', async () => {
  get.mockResolvedValue(view())
  render(<SubcontractorPayroll startDate="2026-03-01" endDate="2026-03-31" isAdmin={false} />)
  await screen.findByText('Ledger')
  expect(screen.queryByLabelText('How subcontractors get paid')).toBeNull()
  expect(screen.getByText(/By hand, from a CSV/)).toBeTruthy()
})

// ── A batch that half-worked ────────────────────────────────────────────────

it('leaves every skipped person on screen, with the reason', async () => {
  await show(STRIPE)
  selectTheRow()
  post.mockResolvedValue({
    rail: 'stripe', settled: true, count: 1, total: 100,
    paid: [{ id: 2, name: 'Paid Person', amount: 100, transfer: 'tr_1' }],
    blocked: [{ id: 3, name: 'Sam Vetter', amount: 60,
                reason: 'Hasn’t set up direct deposit yet.' }],
    failed: [],
    needs_check: [{ id: 4, name: 'Ana Bell', amount: 80,
                    reason: 'A previous attempt never reported back.' }],
  })

  fireEvent.click(screen.getByRole('button', { name: /^Pay 1/ }))

  // Three people to go and do something about. A toast would be gone.
  expect(await screen.findByText('Didn’t go out')).toBeTruthy()
  expect(screen.getByText(/Hasn’t set up direct deposit yet/)).toBeTruthy()
  expect(screen.getByText(/A previous attempt never reported back/)).toBeTruthy()
  expect(screen.getByText('Sam Vetter')).toBeTruthy()
})

it('says nothing about a manual send, which cannot half-work', async () => {
  await show()
  selectTheRow()
  post.mockResolvedValue({ rail: 'manual', settled: false, count: 1, total: 140,
                           csv: 'payout_id\n1\n' })
  const click = URL.createObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()

  fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))

  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(screen.queryByText('Didn’t go out')).toBeNull()
  URL.createObjectURL = click
})

// ── The one action that moves money asks first ──────────────────────────────

it('confirms before a settling rail pays, naming who and how much', async () => {
  // Paying through Stripe marks these PAID and the money leaves the business —
  // irreversible from here. It didn't ask before; it does now.
  await show(STRIPE)
  selectTheRow()
  fireEvent.click(screen.getByRole('button', { name: /^Pay 1/ }))
  await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
  const msg = confirmDialog.mock.calls[0][0]
  expect(msg).toMatch(/\$140\.00/)
  expect(msg).toMatch(/can’t be undone/)
})

it('does not move the money when the confirm is cancelled', async () => {
  confirmDialog.mockResolvedValue(false)
  await show(STRIPE)
  selectTheRow()
  fireEvent.click(screen.getByRole('button', { name: /^Pay 1/ }))
  await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
  expect(post).not.toHaveBeenCalled()
})

it('confirms a manual send too, but as a lighter question', async () => {
  await show()                       // manual rail — settles: false
  selectTheRow()
  fireEvent.click(screen.getByRole('button', { name: /^Send 1/ }))
  await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
  const msg = confirmDialog.mock.calls[0][0]
  expect(msg).toMatch(/marked? as sent|marked sent|as sent/i)
  expect(msg).not.toMatch(/can’t be undone/)   // no money moves on the CSV rail
})

// ── Who can actually receive ────────────────────────────────────────────────

it('marks a sub who cannot take a bank transfer, but only when that matters', async () => {
  const noBank = { ...PAYOUT, direct_deposit: false }
  await show({ ...STRIPE, payouts: [noBank] })
  expect(screen.getByText('no direct deposit')).toBeTruthy()

  cleanup()
  // On the manual rail every row is payable by hand, so the same note would be
  // a warning about nothing.
  await show({ payouts: [noBank] })
  expect(screen.queryByText('no direct deposit')).toBeNull()
})

// ── The number that outlived its own truth ──────────────────────────────────

it('reads the 1099 threshold from the API instead of printing $600 forever', async () => {
  await show({ ytd: { year: 2026, threshold: 2000, total: 0, outstanding: 0,
                      subs: [{ user_id: 5, cleaner_id: 'CT-1', name: 'Dana Reed',
                               jobs: 20, total: 2400, paid: 2400, outstanding: 0,
                               over_1099_threshold: true }] } })
  expect(screen.getByText(/passed \$2,000 for 2026/)).toBeTruthy()
  expect(screen.queryByText(/\$600/)).toBeNull()
})
