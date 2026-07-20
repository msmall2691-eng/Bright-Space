/**
 * Convert-to-Job must default the schedule to the CUSTOMER's requested date
 * (LeadIntake.requested_date) instead of blindly "today", and always show a
 * "Customer requested:" hint so the operator sees the ask even when they pick
 * another day or the ask is already in the past. The quote prop may be a
 * list-serialization row (no `intake` key) — then the modal fetches
 * /api/quotes/:id/details, the only serialization that embeds the intake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import ConvertToJobModal from '../ConvertToJobModal'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { localStorage.setItem('brightbase_jwt', 'test-jwt') })

const _todayISO = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const _json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

let fetchCalls
const mockFetch = (detailsBody = {}) => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/api/dispatch/employees')) return _json([])
    if (String(url).includes('/details')) return _json(detailsBody)
    return _json({})
  }))
}

const QUOTE = { id: 7, quote_number: 'Q-2026-007', title: 'Deep clean' }
const dateInput = () => document.querySelector('input[type="date"]')

describe('ConvertToJobModal — customer requested date', () => {
  it('defaults the date to a future intake requested_date and shows the hint', async () => {
    mockFetch()
    render(<ConvertToJobModal quote={{ ...QUOTE, intake: { requested_date: '2030-05-20' } }} onClose={() => {}} />)
    await waitFor(() => expect(dateInput().value).toBe('2030-05-20'))
    expect(screen.getByText(/Customer requested:/).textContent).toContain('May 20, 2030')
    // Inline intake — no /details round-trip needed.
    expect(fetchCalls.some(u => u.includes('/details'))).toBe(false)
  })

  it('keeps today for a PAST requested date but still shows the hint', async () => {
    mockFetch()
    render(<ConvertToJobModal quote={{ ...QUOTE, intake: { requested_date: '2020-01-10' } }} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Customer requested:/)).toBeTruthy())
    expect(dateInput().value).toBe(_todayISO())          // past ask never defaults
    expect(screen.getByText(/Customer requested:/).textContent).toContain('in the past')
  })

  it('fetches /details when the quote prop has no intake key (list shape)', async () => {
    mockFetch({ intake: { requested_date: '2030-06-01' } })
    render(<ConvertToJobModal quote={QUOTE} onClose={() => {}} />)
    await waitFor(() => expect(dateInput().value).toBe('2030-06-01'))
    expect(fetchCalls.some(u => u.includes('/api/quotes/7/details'))).toBe(true)
  })

  it('tolerates an ISO-timestamp leak in requested_date', async () => {
    mockFetch()
    render(<ConvertToJobModal quote={{ ...QUOTE, intake: { requested_date: '2030-07-07T22:18:23.208Z' } }} onClose={() => {}} />)
    await waitFor(() => expect(dateInput().value).toBe('2030-07-07'))
  })

  it('falls back to today when there is no requested date at all', async () => {
    mockFetch({ intake: null })
    render(<ConvertToJobModal quote={QUOTE} onClose={() => {}} />)
    // Give the /details fetch a tick to resolve, then assert nothing moved.
    await waitFor(() => expect(fetchCalls.some(u => u.includes('/details'))).toBe(true))
    expect(dateInput().value).toBe(_todayISO())
    expect(screen.queryByText(/Customer requested:/)).toBeNull()
  })
})
