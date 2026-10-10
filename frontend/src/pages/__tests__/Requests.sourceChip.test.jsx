/**
 * Where a lead came from, said truthfully.
 *
 * `SOURCE_CONFIG` was a closed map of four, and `SourceChip` fell back to
 * `SOURCE_CONFIG.website` for anything else — so a lead that arrived from a
 * Facebook Lead Ad displayed the word **Website**. That is not a graceful
 * fallback, it is a wrong answer about provenance, on the page where the
 * owner decides what her advertising is doing.
 *
 * Asserted through the rendered page rather than by exporting the map,
 * because the map being right and the chip reading it are two different
 * things and only the second one is what she sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/AiInsight', () => ({ default: () => null }))
vi.mock('../../components/PropertyPhoto', () => ({ default: () => null }))
vi.mock('../../components/requests/RequestThreadPanel', () => ({ default: () => null }))

import { get, getCached } from '../../api'
import Requests from '../Requests'

const lead = (over) => ({
  id: 1, name: 'Anna Sweet', email: 'anna@example.com', phone: '+12075550111',
  status: 'new', priority: 'normal', service_type: 'residential',
  source: 'website', created_at: '2026-10-09T12:00:00Z', ...over,
})

function drawWith(rows) {
  get.mockImplementation((url) => Promise.resolve(
    String(url).startsWith('/api/intake') ? rows : []))
  return render(<MemoryRouter initialEntries={['/requests']}><Requests /></MemoryRouter>)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset(); getCached.mockReset()
  getCached.mockResolvedValue([])
})
afterEach(cleanup)

describe('the source chip', () => {
  it('names Facebook rather than calling a Meta lead a website form', async () => {
    drawWith([lead({ source: 'facebook' })])
    await waitFor(() => expect(screen.getByText('Facebook')).toBeTruthy())
    expect(screen.queryByText('Website'), 'a Facebook lead still claims to be a website form').toBeNull()
  })

  it('still names the website form Website', async () => {
    // The other half: suppressing the wrong label everywhere would pass the
    // case above and break the source this page mostly shows.
    drawWith([lead({ source: 'website' })])
    await waitFor(() => expect(screen.getByText('Website')).toBeTruthy())
  })

  it('shows an unlisted source by its own name, not as Website', async () => {
    // `source` is free text normalized on the backend ("referral", "phone"),
    // so the fallback is reached by real data, not just by a hypothetical.
    drawWith([lead({ source: 'referral' })])
    await waitFor(() => expect(screen.getByText('Referral')).toBeTruthy())
    expect(screen.queryByText('Website')).toBeNull()
  })

  it('offers Facebook in the source filter, so the chip is reachable', async () => {
    // The chip and the filter derive from the same map; a lead you can see
    // but cannot filter to is half a feature.
    drawWith([lead({ source: 'facebook' })])
    fireEvent.click(await screen.findByRole('button', { name: /Filters/ }))
    const select = await screen.findByLabelText('Filter by lead source')
    expect([...select.options].map(o => o.value)).toContain('facebook')
  })
})
