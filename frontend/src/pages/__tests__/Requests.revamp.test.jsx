/**
 * Requests — the triage surface, after the Tier 3 revamp.
 *
 * What the survey found and this file pins:
 *
 *  - **Five of seven actions were behind a kebab.** Quoting and archiving are
 *    what an operator DOES to a lead, and both needed the menu opened first.
 *    They are inline on the card now; the name opens the record.
 *  - **Archive fired silently.** The row vanished with no feedback, and a
 *    FAILED archive vanished the row too — the error went only to the console
 *    while the UI had already dropped it. It now reports, offers Undo, and a
 *    failure keeps the lead.
 *  - **Status and priority colours missed their floors** (BB-A11Y-02).
 *
 * The contrast cases assert the COMPUTED ratio against all four light grounds
 * rather than a class name, so moving a step is allowed and dropping below the
 * floor is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/AiInsight', () => ({ default: () => null }))
vi.mock('../../components/PropertyPhoto', () => ({ default: () => null }))
vi.mock('../../components/requests/RequestThreadPanel', () => ({ default: () => null }))

import { get, patch } from '../../api'
import { subscribe } from '../../utils/toastBus'
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../Requests'
import Requests from '../Requests'

const LEAD = {
  id: 7, name: 'Jane Doe', email: 'jane@example.com', phone: '2075550111',
  address: '5 Oak Ave', service_type: 'residential', status: 'new',
  priority: 'high', created_at: '2026-10-01T10:00:00Z',
}

/** Every toast raised during a test, in order. */
let toasts
let unsub

function draw(rows = [LEAD]) {
  get.mockImplementation((url) =>
    String(url).startsWith('/api/intake')
      ? Promise.resolve(rows)
      : Promise.resolve([]))
  return render(<MemoryRouter initialEntries={['/requests']}><Requests /></MemoryRouter>)
}

/** Mount the page and return the one lead card on it. */
async function card(rows = [LEAD]) {
  draw(rows)
  const name = await screen.findByRole('button', { name: 'Jane Doe' })
  return name.closest('div.bg-panel')
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset(); patch.mockReset()
  patch.mockResolvedValue({})
  toasts = []
  unsub = subscribe(t => toasts.push(t))
})
afterEach(() => { unsub?.(); cleanup() })

describe('Requests — the triage verbs are on the card', () => {
  it('offers Quote and Archive without opening a menu', async () => {
    const c = await card()
    expect(within(c).getByRole('button', { name: /^Quote$/ })).toBeTruthy()
    expect(within(c).getByRole('button', { name: /^Archive$/ })).toBeTruthy()
  })

  it('keeps Convert and Delete in the menu — triage is two verbs, not five', async () => {
    const c = await card()
    // Not on the card until the menu is opened.
    expect(within(c).queryByRole('button', { name: /convert to client/i })).toBeNull()
    fireEvent.click(within(c).getByRole('button', { name: 'More actions' }))
    expect(within(c).getByRole('button', { name: /convert to client/i })).toBeTruthy()
    expect(within(c).getByRole('button', { name: /delete permanently/i })).toBeTruthy()
  })

  it('opens the record from the name', async () => {
    const c = await card()
    fireEvent.click(within(c).getByRole('button', { name: 'Jane Doe' }))
    // The drawer identifies itself by the request id, which nothing on the
    // card carries — the name alone would also match the card we clicked.
    expect(await screen.findByText('Request #7')).toBeTruthy()
    expect(screen.getByRole('button', { name: /open full view/i })).toBeTruthy()
  })
})

describe('Requests — archiving reports itself', () => {
  it('removes the lead and offers Undo', async () => {
    const c = await card()
    fireEvent.click(within(c).getByRole('button', { name: /^Archive$/ }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/intake/7', { status: 'archived' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jane Doe' })).toBeNull())

    const t = toasts.at(-1)
    expect(t.variant).toBe('success')
    expect(t.action?.label).toBe('Undo')
  })

  it('Undo restores the PRIOR status, not a guess', async () => {
    const reviewed = { ...LEAD, status: 'reviewed' }
    const c = await card([reviewed])
    fireEvent.click(within(c).getByRole('button', { name: /^Archive$/ }))
    await waitFor(() => expect(toasts.at(-1)?.action).toBeTruthy())

    patch.mockClear()
    await toasts.at(-1).action.onClick()
    expect(patch).toHaveBeenCalledWith('/api/intake/7', { status: 'reviewed' })
    expect(await screen.findByRole('button', { name: 'Jane Doe' })).toBeTruthy()
  })

  it('a FAILED archive keeps the lead and says so', async () => {
    // The old behaviour: the row was dropped optimistically and the error went
    // only to console, so a failed archive looked exactly like a successful one.
    patch.mockRejectedValueOnce(new Error('boom'))
    const c = await card()
    fireEvent.click(within(c).getByRole('button', { name: /^Archive$/ }))

    await waitFor(() => expect(toasts.at(-1)?.variant).toBe('error'))
    expect(screen.getByRole('button', { name: 'Jane Doe' })).toBeTruthy()
  })
})

describe('Requests — the list is two columns on a desktop window', () => {
  it('uses the shell: breakpoint, not lg:', async () => {
    const c = await card()
    const grid = c.closest('.grid')
    expect(grid.className).toContain('shell:grid-cols-2')
    // `lg:` is 1024 — the owner's window is ~940, so it would hide this.
    expect(grid.className).not.toContain('lg:grid-cols')
  })
})

/* ---- BB-A11Y-02 ------------------------------------------------------- */

const PALETTE = {
  'amber-500': '#f59e0b', 'amber-600': '#d97706', 'amber-700': '#b45309', 'amber-800': '#92400e',
  'emerald-500': '#10b981', 'emerald-600': '#059669', 'emerald-700': '#047857', 'emerald-800': '#065f46',
  'red-600': '#dc2626', 'red-700': '#b91c1c',
  'rose-600': '#e11d48',
}
const LIGHT = ['#ffffff', '#f7f7f8', '#f1f1f3', '#e9e9ec']
const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1).slice(i, i + 2), 16))
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
/** The light-mode step out of a "x-700 dark:x-300" pair, or a bare one. */
const lightStep = (cls) => (cls.match(/(?:^|\s)(?:bg|text)-((?:amber|emerald|red|rose)-\d{3})\b/) || [])[1] || null

describe('Requests — status and priority clear their floors', () => {
  it('every coloured status dot clears 3:1 on all four grounds', () => {
    // A dot is non-text, so 3:1. The 500s missed even that (amber-500 1.77).
    let checked = 0
    for (const [key, cfg] of Object.entries(STATUS_CONFIG)) {
      const step = lightStep(cfg.dot)
      if (!step) continue          // ink-3 and the accent are tokens, not ramp steps
      const hex = PALETTE[step]
      expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
      for (const g of LIGHT) {
        const got = ratio(hex, g)
        expect(got, `${key}'s dot (${step}) on ${g} is ${got.toFixed(2)}:1, under 3:1`)
          .toBeGreaterThanOrEqual(3)
      }
      checked++
    }
    // Guard against a refactor that empties the map and makes this vacuous.
    expect(checked).toBeGreaterThanOrEqual(2)
  })

  it('every coloured priority label clears 4.5:1 on all four grounds', () => {
    let checked = 0
    for (const [key, cfg] of Object.entries(PRIORITY_CONFIG)) {
      const step = lightStep(cfg.color)
      if (!step) continue          // low/normal are plain ink
      const hex = PALETTE[step]
      expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
      for (const g of LIGHT) {
        const got = ratio(hex, g)
        expect(got, `${key} priority (${step}) on ${g} is ${got.toFixed(2)}:1, under 4.5:1`)
          .toBeGreaterThanOrEqual(4.5)
      }
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(2)
  })
})
