/**
 * Requests — filters arrive from the URL and reach the server query.
 *
 * Why this exists: the Quote funnel counts "25 requests from the website" and
 * had nowhere to send you, because this page's filters were `useState` and the
 * frontend never sent `source` at all — even though `/api/intake` has always
 * accepted it. These tests pin the two halves of that fix: the URL is read into
 * the filters, and the filters reach the request.
 *
 * They assert the actual `/api/intake?…` query string, not component internals,
 * because that string is the contract the deep link depends on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
// Heavy children that fetch or portal, stubbed to keep this about the query.
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/AiInsight', () => ({ default: () => null }))
vi.mock('../../components/PropertyPhoto', () => ({ default: () => null }))
vi.mock('../../components/requests/RequestThreadPanel', () => ({ default: () => null }))

import { get, getCached } from '../../api'
import Requests from '../Requests'

function draw(url) {
  return render(<MemoryRouter initialEntries={[url]}><Requests /></MemoryRouter>)
}

/** Every `/api/intake` URL requested so far. */
function intakeCalls() {
  return get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/intake'))
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset(); getCached.mockReset()
  getCached.mockResolvedValue([])
  get.mockResolvedValue([])
})
afterEach(cleanup)

describe('Requests — filters from the URL', () => {
  it('sends no filter params for a bare /requests', async () => {
    draw('/requests')
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(0))
    const url = intakeCalls()[0]
    for (const p of ['status=', 'service_type=', 'priority=', 'source=']) {
      expect(url, `bare /requests should not send ${p}`).not.toContain(p)
    }
  })

  it('sends source from the URL — the funnel deep link', async () => {
    draw('/requests?source=website')
    await waitFor(() => expect(intakeCalls().some(u => u.includes('source=website'))).toBe(true))
  })

  it('sends several filters together', async () => {
    draw('/requests?source=sms&status=new&priority=high&service_type=commercial')
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(0))
    const url = intakeCalls().find(u => u.includes('source=sms'))
    expect(url).toBeTruthy()
    expect(url).toContain('status=new')
    expect(url).toContain('priority=high')
    expect(url).toContain('service_type=commercial')
  })

  it('treats an unknown-but-harmless param as absent rather than crashing', async () => {
    draw('/requests?source=')
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(0))
    expect(intakeCalls()[0]).not.toContain('source=')
  })

  it('still opens the create modal from ?new=1 while filtering', async () => {
    // The regression risk: a filter write that rebuilt the query from scratch
    // would eat `?new=1` before the modal effect saw it.
    draw('/requests?new=1&source=website')
    await waitFor(() => expect(intakeCalls().some(u => u.includes('source=website'))).toBe(true))
    // Target the modal's own heading — "New Request" also labels the trigger
    // button, so a loose text match finds both.
    expect(await screen.findByRole('heading', { name: 'New Request' })).toBeTruthy()
    expect(screen.getByText('Name *')).toBeTruthy()
  })
})

describe('Requests — the source filter is reachable by hand', () => {
  it('offers a source control whose options come from SOURCE_CONFIG', async () => {
    draw('/requests')
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(0))
    // Filters are collapsed by default on this page.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    const select = await screen.findByLabelText('Filter by lead source')
    const labels = [...select.querySelectorAll('option')].map(o => o.textContent)
    expect(labels).toContain('All Sources')
    // The four SourceChip kinds, so the chip and the filter cannot drift.
    expect(labels).toContain('Website')
    expect(labels).toContain('SMS')
    expect(labels).toContain('Email')
    expect(labels).toContain('Chat')
  })

  it('picking a source refetches with it, and clearing drops the param', async () => {
    draw('/requests')
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    const select = await screen.findByLabelText('Filter by lead source')

    fireEvent.change(select, { target: { value: 'email' } })
    await waitFor(() => expect(intakeCalls().some(u => u.includes('source=email'))).toBe(true))

    const before = intakeCalls().length
    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(intakeCalls().length).toBeGreaterThan(before))
    expect(intakeCalls().at(-1)).not.toContain('source=')
  })
})
