/**
 * The confirmations feed: shows what the customer agreed to, and disappears
 * when there is nothing.
 *
 * The empty case is the one that matters most and is easiest to lose in a
 * later refactor. This box is below the fold on the busiest screen in the app,
 * and most days there are no confirmations — a box that renders its header and
 * an empty list would put permanent furniture on the board for nothing, which
 * is the opposite of what the owner asked for ("nothing to do, just so you
 * know"). MarketplaceBoard and BenchDigest follow the same rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const ENDPOINT = '/api/jobs/recent-confirmations'

let fetchMock
let payload

const calls = (needle) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(needle)).length

beforeEach(() => {
  vi.resetModules()
  payload = { confirmations: [] }
  fetchMock = vi.fn(async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => payload,
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = async () => {
  const C = (await import('../CustomerConfirmations')).default
  return render(<MemoryRouter><C /></MemoryRouter>)
}

/** The first row. Scoped deliberately: the box HEADER also reads "Customers
 *  confirmed", so an unscoped /confirmed/i query matches two elements and
 *  would assert against the header instead of the data. */
const firstRow = async (container) => {
  await waitFor(() => expect(container.querySelector('li')).toBeTruthy())
  return container.querySelector('li')
}

describe('CustomerConfirmations', () => {
  it('renders nothing at all when no one has confirmed', async () => {
    const { container } = await mount()
    await waitFor(() => expect(calls(ENDPOINT)).toBe(1))
    expect(container.textContent,
      'an empty feed still drew its box — this is below the fold on the busiest '
      + 'screen and is empty most days').toBe('')
  })

  it('names the customer and the visit they confirmed', async () => {
    payload = { confirmations: [{
      job_id: 42, title: 'Weekly clean', client_id: 7, client_name: 'Dana',
      scheduled_date: '2026-11-02', start_time: '09:30',
      confirmed_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    }] }
    const { container } = await mount()

    const row = await firstRow(container)
    expect(row.textContent).toContain('Dana')
    expect(row.textContent).toMatch(/Mon, Nov 2/)   // local noon, not UTC midnight
    expect(row.textContent).toMatch(/9:30am/)
    expect(row.textContent).toMatch(/3h ago/)
    // Plain DOM, not toHaveAttribute — this suite doesn't load jest-dom.
    expect(screen.getByRole('link', { name: /open/i }).getAttribute('href')).toBe('/jobs/42')
  })

  it('reads the date as a local day, not the day before', async () => {
    // `new Date('2026-11-02')` is UTC midnight, which renders as Nov 1 in every
    // US timezone. This repo has shipped that bug before, so it is pinned here
    // rather than left to the formatter.
    payload = { confirmations: [{
      job_id: 1, client_name: 'Sam', scheduled_date: '2026-11-02',
      start_time: null, confirmed_at: new Date().toISOString(),
    }] }
    const { container } = await mount()
    const row = await firstRow(container)
    expect(row.textContent, 'the date slipped a day — parse at local noon').toMatch(/Nov 2/)
    expect(row.textContent).not.toMatch(/Nov 1/)
  })

  it('survives a failed fetch by showing nothing, not an error box', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, headers: { get: () => null },
      json: async () => ({ detail: 'boom' }),
    }))
    const { container } = await mount()
    await waitFor(() => expect(calls(ENDPOINT)).toBe(1))
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('reads a naive UTC timestamp as UTC, not as browser-local', async () => {
    // The API serializes customer_confirmed_at from a timezone-NAIVE column
    // (database/models.py: Column(DateTime)), written with
    // datetime.now(timezone.utc). So the wire value has no offset —
    // "2026-11-02T09:30:00" — and `new Date()` reads an offset-free ISO string
    // as BROWSER-LOCAL. West of Greenwich that puts a just-now confirmation in
    // the future, and every row reads "1m ago" forever.
    //
    // Found in review. The first version of this test fed the component
    // `new Date().toISOString()`, which ends in Z — a shape the server never
    // sends — so it passed while the bug was live.
    const threeHoursAgoUtc = new Date(Date.now() - 3 * 3600 * 1000)
      .toISOString().replace(/\.\d+Z$/, '')          // strip the Z: naive, as the API sends
    payload = { confirmations: [{
      job_id: 5, client_name: 'Sam', scheduled_date: null, start_time: null,
      confirmed_at: threeHoursAgoUtc,
    }] }
    const { container } = await mount()
    const row = await firstRow(container)
    expect(row.textContent,
      'a naive UTC timestamp was read as local time, so the age is wrong')
      .toMatch(/3h ago/)
  })

  it('fetches once, and does not poll', async () => {
    payload = { confirmations: [{ job_id: 1, client_name: 'Sam', confirmed_at: new Date().toISOString() }] }
    const { container } = await mount()
    await firstRow(container)
    await new Promise(r => setTimeout(r, 60))
    expect(calls(ENDPOINT), 'more than one request — brightbase-economy rule 2').toBe(1)
  })
})
