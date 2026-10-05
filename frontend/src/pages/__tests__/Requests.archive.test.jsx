/**
 * The per-card Archive gate.
 *
 * Archive used to be the odd one out in its own kebab menu: "Delete
 * permanently" right below it confirmed, and so did the bulk "Archive N", but
 * archiving a single lead from its card fired a PATCH on one click. Archive is
 * reversible (the row stays under the Archived filter), so the gate is a plain
 * confirm — danger styling stays reserved for the delete sibling.
 *
 * RequestCard is module-local, so these drive the real page and the real kebab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('../../utils/toastBus', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
const confirmDialog = vi.fn(() => Promise.resolve(true))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: (...a) => confirmDialog(...a) }))
// Children that fetch on their own and aren't under test.
vi.mock('../../components/PropertyPhoto', () => ({ default: () => null }))
vi.mock('../../components/AiInsight', () => ({ default: () => null }))
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/requests/RequestThreadPanel', () => ({ RequestThreadPanel: () => null }))

import { get, patch } from '../../api'
import Requests from '../Requests'

const render = () => rtlRender(<MemoryRouter><Requests /></MemoryRouter>)

// status 'new' matters — the Archive menu item is gated on status !== 'archived'.
const lead = (id, name) => ({
  id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`,
  status: 'new', service_type: 'residential', priority: 'normal',
  created_at: '2026-10-02T12:00:00Z',
})
const JANE = lead(11, 'Jane Doe')
const BOB = lead(12, 'Bob Roe')

// The kebab trigger is an icon-only <button> with no accessible name, so it
// can't be reached by role+name. Filtering for nameless buttons works because
// every other button on screen carries text; the length check is a canary so a
// future icon-only button in the page chrome fails loudly here instead of
// silently clicking the wrong thing.
const openKebab = (scope) => {
  const buttons = scope ? within(scope).getAllByRole('button') : screen.getAllByRole('button')
  const nameless = buttons.filter(b => !b.textContent.trim())
  expect(nameless).toHaveLength(1)
  fireEvent.click(nameless[0])
}
const cardFor = (name) => screen.getByText(name).closest('.bg-panel')

beforeEach(() => {
  vi.clearAllMocks()
  confirmDialog.mockResolvedValue(true)
  patch.mockResolvedValue({})
})
afterEach(cleanup)

describe('per-card Archive confirm', () => {
  it('archives nothing when the confirm is cancelled', async () => {
    confirmDialog.mockResolvedValue(false)
    get.mockResolvedValue([JANE])
    render()
    await screen.findByText('Jane Doe')
    openKebab()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1))
    expect(patch).not.toHaveBeenCalled()
    expect(screen.getByText('Jane Doe')).toBeTruthy()   // row stays put
  })

  it('names the lead, promises it is reversible, and archives on a yes', async () => {
    get.mockResolvedValue([JANE])
    render()
    await screen.findByText('Jane Doe')
    openKebab()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled())

    const [msg, opts] = confirmDialog.mock.calls[0]
    expect(msg).toContain('Jane Doe')
    expect(msg).toMatch(/Archived filter/)
    expect(opts.confirmLabel).toBe('Archive')
    // Reversible, so it must NOT borrow the delete sibling's danger styling.
    expect(opts.danger).toBeFalsy()

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/intake/11', { status: 'archived' }))
    await waitFor(() => expect(screen.queryByText('Jane Doe')).toBeNull())
  })

  it('does not resurrect a row when two archives overlap', async () => {
    // The dialog closes on yes while the PATCH is still in flight, so two
    // human-paced archives can interleave. A stale `requests` snapshot in the
    // slower handler would write the faster one's row back onto the list.
    get.mockResolvedValue([JANE, BOB])
    let resolveJane
    patch.mockImplementationOnce(() => new Promise(r => { resolveJane = r }))
    patch.mockResolvedValue({})
    render()
    await screen.findByText('Jane Doe')

    openKebab(cardFor('Jane Doe'))
    fireEvent.click(within(cardFor('Jane Doe')).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/intake/11', { status: 'archived' }))

    openKebab(cardFor('Bob Roe'))
    fireEvent.click(within(cardFor('Bob Roe')).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.queryByText('Bob Roe')).toBeNull())

    resolveJane({})
    await waitFor(() => expect(screen.queryByText('Jane Doe')).toBeNull())
    expect(screen.queryByText('Bob Roe')).toBeNull()
  })
})
