/**
 * The bench screen.
 *
 * What's pinned here is mostly what must NOT appear. The bench is the screen
 * that would make a decline-rate column or an on-time percentage tempting, and
 * both would be the app arguing against the contract the sub signed — section 2
 * says declining is free, and timing a contractor's arrival is supervision of
 * hours (services/bench.py has the long version).
 *
 * Plus the design language the owner has enforced three times — dot + word,
 * never a filled pill or a count bubble — and one real bug this component
 * shipped with: `viewDoc` was defined inside the parent and called from a
 * sibling function component, so "View" on any document threw a ReferenceError
 * and the office could not open a certificate to check its dates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), download: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { download, get, post } from '../../../api'
import BenchRoster from '../BenchRoster'

const PERSON = {
  user_id: 7, name: 'Dana Fields', email: 'dana@example.com', cleaner_id: 'CT-DANA',
  status: 'active', complete: true, missing: [], exempt: false, can_work: true,
  awaiting_review: [], agreement_signed: true,
  documents: [
    { kind: 'coi', label: 'Certificate of insurance', status: 'accepted',
      expires_at: '2027-01-31', uploaded_at: null, filename: 'coi.pdf' },
  ],
  work: {
    completed: 12, on_day: 11, upcoming: 2, last_worked: '2026-09-02',
    pending_requests: 1, history_days: 90,
  },
  paid_ytd: 1240.5, form_1099_due: true,
}

const BENCH = {
  people: [PERSON],
  totals: { people: 1, can_work: 1, awaiting_review: 0, incomplete: 0,
            blocked: 0, form_1099_due: 1 },
  enforce_from: null, history_days: 90,
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); download.mockReset()
  get.mockResolvedValue(BENCH)
})
afterEach(cleanup)

// ── one request draws it ───────────────────────────────────────────────────

it('draws the whole screen from one request', async () => {
  render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  expect(get).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenCalledWith('/api/crew/bench')
})

// ── the work line ──────────────────────────────────────────────────────────

it('reports work as outcomes, with on-the-day as a count not a percentage', async () => {
  render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  expect(screen.getByText(/12 jobs in the last 90 days/)).toBeTruthy()
  // "11 finished on the day", never "92%" — 1 of 1 would read as 100%.
  expect(screen.getByText(/11 finished on the day/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/%/)
})

it('shows the 1099 in September rather than in January', async () => {
  render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  expect(screen.getByText(/1,240\.50 this year/)).toBeTruthy()
  expect(screen.getByText('1099 due')).toBeTruthy()
})

it('says so plainly when somebody has done nothing yet', async () => {
  get.mockResolvedValue({
    ...BENCH,
    people: [{ ...PERSON, paid_ytd: 0, form_1099_due: false,
               work: { completed: 0, on_day: 0, upcoming: 0, last_worked: null,
                       pending_requests: 0, history_days: 90 } }],
  })
  render(<BenchRoster />)
  expect(await screen.findByText('No work yet')).toBeTruthy()
})

// ── what must never appear ─────────────────────────────────────────────────

it('never shows a decline count or a punctuality figure', async () => {
  render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  const text = document.body.textContent.toLowerCase()
  for (const banned of ['declin', 'on time', 'on-time', 'late', 'punctual', 'rating', 'stars']) {
    expect(text).not.toContain(banned)
  }
})

it('uses dot-and-word status, not filled pills or count bubbles', async () => {
  const { container } = render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  // The vetoed pattern is a RESTING tinted fill — bg-*-100 / rounded-full
  // capsules. Hover tints are fine and deliberately not matched here.
  const html = container.innerHTML
  // (?!\d) matters: without it `bg-emerald-500` — the DOT, which is required —
  // matches the `bg-emerald-50` alternative and the check fails on correct
  // markup. (?<!hover:) keeps transient interactive tints out of scope; only a
  // resting fill is the vetoed pattern.
  expect(html).not.toMatch(/(?<!hover:)bg-(amber|red|emerald|blue|indigo)-(50|100|200)(?!\d)/)
  expect(html).not.toMatch(/rounded-full[^"]*\bbg-\w+-(50|100|200)(?!\d)/)
  // Status is carried by a 6px dot beside a word.
  expect(container.querySelectorAll('.h-1\\.5.w-1\\.5.rounded-full').length).toBeGreaterThan(0)
})

// ── the bug it shipped with ────────────────────────────────────────────────

it('opens a document instead of throwing', async () => {
  render(<BenchRoster />)
  await screen.findByText('Dana Fields')
  fireEvent.click(screen.getByRole('button', { name: /view/i }))
  await waitFor(() => expect(download).toHaveBeenCalledWith(
    '/api/auth/users/7/file/coi/download', 'coi.pdf'))
})

it('degrades to a sentence rather than an empty page', async () => {
  get.mockRejectedValue(new Error('nope'))
  render(<BenchRoster />)
  expect(await screen.findByText(/Couldn’t load crew files just now/)).toBeTruthy()
})
