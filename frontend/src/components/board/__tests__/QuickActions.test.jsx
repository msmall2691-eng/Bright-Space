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

  // ── the grid closes its own row ────────────────────────────────────────
  //
  // Seven tiles in a four-across grid leave one empty cell, which on Home's
  // full-width tail row was a 148px gap after "Quick note" — a tile-shaped
  // hole in the one panel that is nothing but tiles. The last tile stretches
  // over whatever is left instead, at every track count.
  //
  // Read off the classes rather than a layout: jsdom does not do grid, so the
  // only honest check is that the spans the component emits add up.
  const COLS = { base: 3, sm: 7, shell: 4 }
  const spanOf = (el, prefix) => {
    const re = new RegExp(`^${prefix}col-span-(\\d+)$`)
    const hit = [...el.classList].map(c => c.match(re)).find(Boolean)
    return hit ? Number(hit[1]) : 1
  }

  it('never ends on an empty cell — the last tile fills the row', () => {
    for (const wide of [true, false]) {
      cleanup()
      render(<QuickActions navigate={navigate} wide={wide} />)
      const all = tiles()
      const last = all[all.length - 1]
      const n = all.length

      // base (phone, 3 across) and sm (7 across) always apply; shell only
      // narrows the grid when Home did NOT give this panel the whole row.
      const steps = [['', COLS.base], ['sm:', COLS.sm]]
      if (!wide) steps.push(['shell:', COLS.shell])

      for (const [prefix, cols] of steps) {
        const span = spanOf(last, prefix)
        // cells used by the full-width run of tiles, with the last one spanning
        const cells = (n - 1) + span
        expect(cells % cols, `wide=${wide} ${prefix || 'base'}:${cols} across — ` +
          `${n} tiles, last spans ${span}, ${cells} cells`).toBe(0)
        expect(span).toBeLessThanOrEqual(cols)
      }
    }
  })

  it('gives every breakpoint an explicit span, so none leaks into the next', () => {
    // An unprefixed `col-span-3`, correct for three tracks on a phone, carries
    // straight into the seven-track row and pushes the last tile onto a line of
    // its own. Each step must restate its own span, `col-span-1` included.
    render(<QuickActions navigate={navigate} wide />)
    const all = tiles()
    const cls = [...all[all.length - 1].classList]
    expect(cls.some(c => /^col-span-\d+$/.test(c))).toBe(true)
    expect(cls.some(c => /^sm:col-span-\d+$/.test(c))).toBe(true)
  })

  it('goes seven across on a full row and four when it only has half of one', () => {
    render(<QuickActions navigate={navigate} wide />)
    let grid = screen.getByTestId('home-quick-actions').querySelector('[class*=grid-cols]')
    expect(grid.className).toContain('sm:grid-cols-7')
    expect(grid.className).not.toContain('shell:grid-cols-4')

    cleanup()
    render(<QuickActions navigate={navigate} wide={false} />)
    grid = screen.getByTestId('home-quick-actions').querySelector('[class*=grid-cols]')
    expect(grid.className).toContain('shell:grid-cols-4')
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
