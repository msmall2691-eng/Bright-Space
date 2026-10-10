/**
 * Requests — bulk archive writes from the LATEST list, not a captured one.
 *
 * `bulkArchive` awaits a confirm and then a whole batch of PATCHes, so there is
 * a long, user-paced gap between the operator's click and the write. It used to
 * finish that write with
 *
 *     setRequests(requests.filter(r => !archived.has(r.id)))
 *
 * reading `requests` out of the render closure — the array as it stood when the
 * button was clicked. Everything that changed the list during the gap was
 * reverted on that write, so a lead archived or deleted by one of the per-row
 * actions came BACK on screen, already archived on the server, with nothing to
 * say the row was a display artifact.
 *
 * Its siblings never had the bug: `handleArchive`, `handleDelete`, the Undo
 * re-add and `handleConvertToClient` all write `setRequests(prev => ...)`, and
 * `handleDelete` even carries a comment about this exact staleness for the
 * selection set (Codex review on #530). `bulkArchive` was the one outlier, and
 * the one with the widest gap to be stale across.
 *
 * The test below IS the interleave, which is what makes it mutation-checked
 * rather than decorative: the bulk PATCH is parked mid-flight, a second lead is
 * archived from its own card while the batch hangs, and only then does the bulk
 * write land. A closure read writes [Jane, Ray] minus {Jane} and puts Ray back;
 * the functional updater writes [Jane] minus {Jane} and leaves him gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
// Bulk archive confirms first; the per-row archive deliberately does not.
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/AiInsight', () => ({ default: () => null }))
vi.mock('../../components/PropertyPhoto', () => ({ default: () => null }))
vi.mock('../../components/requests/RequestThreadPanel', () => ({ default: () => null }))

import { get, patch } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import Requests from '../Requests'

// Distinct names AND distinct addresses, so buildRequestFeed flags neither as a
// possible duplicate and both cards are on the page.
const JANE = {
  id: 7, name: 'Jane Doe', email: 'jane@example.com', phone: '2075550111',
  address: '5 Oak Ave', service_type: 'residential', status: 'new',
  priority: 'high', created_at: '2026-10-01T10:00:00Z',
}
const RAY = {
  id: 8, name: 'Ray Poole', email: 'ray@example.com', phone: '2075550222',
  address: '12 Birch Rd', service_type: 'residential', status: 'new',
  priority: 'normal', created_at: '2026-10-02T10:00:00Z',
}

/** A lead's name is a button that opens the record, so it stands in for the row. */
const row = (name) => screen.queryByRole('button', { name })
const cardFor = async (name) =>
  (await screen.findByRole('button', { name })).closest('div.bg-panel')

function draw(rows) {
  get.mockImplementation((url) =>
    String(url).startsWith('/api/intake') ? Promise.resolve(rows) : Promise.resolve([]))
  return render(<MemoryRouter initialEntries={['/requests']}><Requests /></MemoryRouter>)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset(); patch.mockReset(); confirmDialog.mockReset()
  confirmDialog.mockResolvedValue(true)
})
afterEach(cleanup)

describe('Requests — bulk archive and the per-row actions share one list', () => {
  it('does not resurrect a lead archived while the batch was still in flight', async () => {
    // Jane's PATCH is the bulk one and hangs until we release it. Ray's — and
    // anything else — resolves at once.
    let releaseBulk
    patch.mockImplementation((url) =>
      url === '/api/intake/7'
        ? new Promise(resolve => { releaseBulk = () => resolve({}) })
        : Promise.resolve({}))

    draw([JANE, RAY])
    const jane = await cardFor('Jane Doe')

    // Select Jane only, then start the bulk archive. The bulk bar's button is
    // "Archive 1"; a card's own button is a bare "Archive".
    fireEvent.click(within(jane).getByRole('checkbox', { name: 'Select lead' }))
    fireEvent.click(screen.getByRole('button', { name: /^Archive 1$/ }))

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/intake/7', { status: 'archived' }))
    expect(screen.getByRole('button', { name: /Archiving/ })).toBeTruthy()
    expect(releaseBulk).toBeDefined()

    // Mid-flight, the operator archives Ray from his own card — a real click:
    // `bulkArchiving` disables the bulk button only, never the cards.
    const ray = await cardFor('Ray Poole')
    fireEvent.click(within(ray).getByRole('button', { name: /^Archive$/ }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/intake/8', { status: 'archived' }))
    await waitFor(() => expect(row('Ray Poole')).toBeNull())

    // Now the batch lands, and writes the list.
    await act(async () => {
      releaseBulk()
      await Promise.resolve()
      await Promise.resolve()
    })

    // THE assertion. Reading `requests` from the closure writes [Jane, Ray]
    // minus {7} = [Ray], so Ray's card reappears here.
    expect(row('Ray Poole')).toBeNull()
    // And Jane really did go, so this cannot pass by the bulk write never
    // having happened at all.
    expect(row('Jane Doe')).toBeNull()
  })
})
