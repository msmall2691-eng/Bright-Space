/**
 * QuickActions — Home's create tiles.
 *
 * The tiles are DERIVED from the route manifest (nav/routes.js CREATE_ACTIONS),
 * so this file deliberately does NOT mock nav/routes: it asserts the rendered
 * tiles against the REAL list. A hand-written stand-in list in a mock factory
 * would assert fake-against-fake and sail straight past the drift this
 * component just had — and would need hand-maintenance beside the component,
 * which is the original bug reintroduced in the test layer.
 *
 * Role comes from localStorage, the way currentRole() reads it (same pattern as
 * pages/__tests__/OpsBoard.test.jsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { CREATE_ACTIONS } from '../../../nav/routes'
import QuickActions from '../QuickActions'

const navigate = vi.fn()
const setRole = (role) =>
  localStorage.setItem('brightbase_user', JSON.stringify({ role, full_name: 'Mariah Small' }))

// The tile set is exactly the section's buttons — its header holds only a span
// and an h2.
const tiles = () => [...screen.getByTestId('home-quick-actions').querySelectorAll('button')]

beforeEach(() => { localStorage.clear(); setRole('admin'); navigate.mockReset() })
afterEach(cleanup)

describe('QuickActions', () => {
  it('renders one tile per manifest create action, in manifest order, plus Quick note', () => {
    render(<QuickActions navigate={navigate} />)
    expect(screen.getByTestId('home-quick-actions')).toBeTruthy()

    // THE no-drift assertion. Every create action in nav/routes.js must be a
    // tile here, and nothing else may be except the one documented Home-only
    // extra. A second hardcoded copy of the list fails this.
    expect(tiles()).toHaveLength(CREATE_ACTIONS.length + 1)
    for (const a of CREATE_ACTIONS) expect(screen.getByTestId(`qa-${a.label}`)).toBeTruthy()
    expect(screen.getByTestId('qa-Quick note')).toBeTruthy()

    // The loop above is vacuous if the manifest is ever emptied, and labels are
    // user-visible wording — so pin them once, literally. A relabel should be a
    // deliberate line in the diff, here and in nav/routes.js together.
    expect(tiles().map(b => b.getAttribute('data-testid'))).toEqual([
      'qa-New lead', 'qa-New message', 'qa-New job',
      'qa-New quote', 'qa-New invoice', 'qa-New client',
      'qa-Quick note',
    ])
  })

  it('deep-links each tile to the URL the manifest gives it', () => {
    render(<QuickActions navigate={navigate} />)
    // Derived, so a stale hardcoded URL in the component fails here.
    for (const a of CREATE_ACTIONS) {
      fireEvent.click(screen.getByTestId(`qa-${a.label}`))
      expect(navigate).toHaveBeenLastCalledWith(a.to)
    }
    expect(navigate).toHaveBeenCalledTimes(CREATE_ACTIONS.length)

    // Spot-check the two URLs carrying a param shape beyond a plain ?new=1, so
    // the loop can't pass against a manifest that lost them.
    navigate.mockReset()
    fireEvent.click(screen.getByTestId('qa-New message'))
    expect(navigate).toHaveBeenCalledWith('/comms?compose=1')
    fireEvent.click(screen.getByTestId('qa-New invoice'))
    expect(navigate).toHaveBeenCalledWith('/billing?view=invoices&new=1')
  })

  it('"Quick note" fires the add-note event instead of navigating', () => {
    const spy = vi.fn()
    window.addEventListener('bb:add-note', spy)
    render(<QuickActions navigate={navigate} />)
    fireEvent.click(screen.getByTestId('qa-Quick note'))
    expect(spy).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    window.removeEventListener('bb:add-note', spy)
  })

  it('renders nothing for a cleaner', () => {
    setRole('cleaner')
    render(<QuickActions navigate={navigate} />)
    // The gate is the manifest's: createActionsFor() returns [] for a cleaner,
    // and an empty list renders nothing — the whole panel is a create surface,
    // so there is no Quick-note-only variant for a non-office role.
    expect(screen.queryByTestId('home-quick-actions')).toBeNull()
  })

  it('renders nothing for a viewer either', () => {
    setRole('viewer')
    render(<QuickActions navigate={navigate} />)
    expect(screen.queryByTestId('home-quick-actions')).toBeNull()
  })
})
