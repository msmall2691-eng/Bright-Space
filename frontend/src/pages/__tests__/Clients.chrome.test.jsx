/**
 * Clients — the chrome, after the Tier 3 pass.
 *
 * The survey's verdict on this page was unusual: the LIST was already fine (a
 * two-up card grid, twelve inline actions — the strongest on any office page).
 * The stack was all in the chrome: four bands always, up to six, above a list
 * that needed none of them.
 *
 * What this file pins:
 *
 *  - **No separate header band.** The PageHero above the toolbar contributed
 *    the word "Clients", an icon, and a subtitle describing what a list page
 *    obviously is. The toolbar carries the title now, as Schedule's does.
 *  - **One meta row.** The selection controls and the CRM-health disclosure
 *    were two full-width bands that both rendered at full height with nothing
 *    selected and nothing expanded.
 *  - **CRM health is still lazy.** It is the page's one expensive scan and it
 *    must not fetch on mount. Moving it into a shared row is exactly the kind
 *    of refactor that would quietly mount it eagerly, so the mount-time
 *    request count is asserted (the Tier 2c lesson).
 *  - **The bucket chips are bare.** They were `border border-hairline-2
 *    bg-panel px-2` around a dot and a word — the boxed "dot-pill" the design
 *    language names as vetoed in those exact classes.
 *  - **The bucket dots clear 3:1** (BB-A11Y-02).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/JobCreateModal', () => ({ default: () => null }))
vi.mock('../../components/clients/ClientPeek', () => ({ default: () => null }))

import { get } from '../../api'
import { BUCKET_META } from '../../components/CRMHealthPanel'
import Clients from '../Clients'

const CLIENTS = [
  { id: 1, name: 'Acme Co', email: 'a@acme.test', status: 'active' },
  { id: 2, name: 'Baker LLC', email: 'b@baker.test', status: 'lead' },
]
const HEALTH = {
  total: 2,
  buckets: {
    real: { count: 1, ids: [1] },
    duplicate: { count: 1, ids: [2] },
    spam_marketing: { count: 0, ids: [] },
    incomplete: { count: 0, ids: [] },
    test: { count: 0, ids: [] },
  },
  by_source: { website: 2 },
  by_status: { active: 1, lead: 1 },
}

/** Every URL `get` has been asked for, in order. */
const urls = () => get.mock.calls.map(c => String(c[0]))

function draw() {
  return render(<MemoryRouter initialEntries={['/clients']}><Clients /></MemoryRouter>)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset()
  get.mockImplementation((url) => {
    const u = String(url)
    if (u.includes('/api/clients/health')) return Promise.resolve(HEALTH)
    if (u.includes('/api/clients/counts')) return Promise.resolve({ active: 1, lead: 1, inactive: 0 })
    if (u.includes('/api/clients')) return Promise.resolve(CLIENTS)
    return Promise.resolve([])
  })
})
afterEach(cleanup)

describe('Clients — the toolbar is the header', () => {
  it('has exactly one page title, and it sits in the toolbar row', async () => {
    draw()
    const h1s = await screen.findAllByRole('heading', { level: 1, name: 'Clients' })
    expect(h1s).toHaveLength(1)
    // The toolbar owns the search box; the title is inside the same row, so
    // the search input and the title share an ancestor that is not the page.
    const row = h1s[0].parentElement
    expect(row.querySelector('input[placeholder="Search clients..."]')).toBeTruthy()
  })

  it('no longer renders the subtitle band', async () => {
    draw()
    await screen.findByRole('heading', { level: 1, name: 'Clients' })
    expect(screen.queryByText(/manage your customer list/i)).toBeNull()
  })
})

describe('Clients — one meta row', () => {
  it('shows the count and select-all, but no bulk actions, with nothing selected', async () => {
    draw()
    expect(await screen.findByTestId('clients-select-all')).toBeTruthy()
    expect(screen.queryByTestId('clients-bulk-actions')).toBeNull()
  })

  it('reveals the bulk actions on a selection, in the same row', async () => {
    draw()
    // Wait for the rows — "Select all" with nothing loaded selects nothing,
    // which is correct behaviour and would make this test pass vacuously.
    await screen.findByText('Acme Co')
    const all = screen.getByTestId('clients-select-all')
    fireEvent.click(all)
    const actions = await screen.findByTestId('clients-bulk-actions')
    // Same row: the select-all control and the actions group share it.
    expect(actions.closest('div.flex.flex-wrap')).toBe(all.closest('div.flex.flex-wrap'))
  })

  it('shares the row with the CRM-health disclosure', async () => {
    draw()
    const all = await screen.findByTestId('clients-select-all')
    const health = await screen.findByRole('button', { name: /CRM health/i })
    // The panel's inline wrapper is `display: contents`, so its trigger is a
    // flex item of the row even though it is not the row's DOM child.
    expect(health.closest('div.flex.flex-wrap')).toBe(all.closest('div.flex.flex-wrap'))
  })
})

describe('Clients — CRM health stays lazy', () => {
  it('does NOT scan on mount', async () => {
    draw()
    await screen.findByRole('heading', { level: 1, name: 'Clients' })
    await waitFor(() => expect(urls().some(u => u.includes('/api/clients?'))).toBe(true))
    // The expensive scan is the one request this page must not make until asked.
    expect(urls().filter(u => u.includes('/api/clients/health'))).toHaveLength(0)
  })

  it('scans once when expanded, and not again on collapse + re-expand', async () => {
    draw()
    const trigger = await screen.findByRole('button', { name: /CRM health/i })

    fireEvent.click(trigger)
    await waitFor(() => expect(urls().filter(u => u.includes('/api/clients/health'))).toHaveLength(1))

    fireEvent.click(trigger)   // collapse
    fireEvent.click(trigger)   // re-expand — data is already held
    await waitFor(() => expect(screen.getByText(/Duplicates: 1/)).toBeTruthy())
    expect(urls().filter(u => u.includes('/api/clients/health'))).toHaveLength(1)
  })

  it('expands onto its own line rather than widening the row', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /CRM health/i }))
    const body = (await screen.findByText(/sum to 2/)).closest('div.w-full')
    // `w-full` inside the flex-wrap row is what drops the body underneath; a
    // body that wasn't full-width would squeeze the row instead.
    expect(body).toBeTruthy()
  })
})

describe('Clients — the CRM-health buckets are bare, not boxed', () => {
  it('a clickable bucket carries no resting border or fill', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /CRM health/i }))
    const chip = await screen.findByRole('button', { name: /Duplicates: 1/ })
    // The vetoed shape, in the exact classes the design language names.
    expect(chip.className).not.toMatch(/(?:^|\s)border-hairline-2(?:\s|$)/)
    expect(chip.className).not.toMatch(/(?:^|\s)bg-panel(?:\s|$)/)
    // It must still read as clickable — a hover reveal, which is allowed.
    expect(chip.className).toContain('hover:border-hairline-2')
    expect(chip.className).toContain('hover:bg-bg-2')
  })

  it('clicking a bucket narrows the list', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /CRM health/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Duplicates: 1/ }))
    // The banner, not the chip — both carry the word "Duplicates", so match on
    // the banner's own sentence and on the narrowed count it reports.
    expect(await screen.findByText(/Showing/)).toBeTruthy()
    expect(screen.getByText(/1 of 2/)).toBeTruthy()
  })
})

/* ---- BB-A11Y-02 ------------------------------------------------------- */

const PALETTE = {
  'amber-500': '#f59e0b', 'amber-700': '#b45309',
  'emerald-500': '#10b981', 'emerald-700': '#047857',
  'rose-500': '#f43f5e', 'rose-600': '#e11d48',
  'blue-600': '#2563eb', 'sky-500': '#0ea5e9',
  'violet-600': '#7c3aed',
}
const LIGHT = ['#ffffff', '#f7f7f8', '#f1f1f3', '#e9e9ec']
const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1).slice(i, i + 2), 16))
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const lightStep = (cls) => (cls.match(/(?:^|\s)bg-((?:amber|emerald|rose|blue|sky|violet)-\d{3})\b/) || [])[1] || null

describe('Clients — every CRM-health dot clears 3:1', () => {
  it('on all four light grounds', () => {
    let checked = 0
    for (const [key, m] of Object.entries(BUCKET_META)) {
      const step = lightStep(m.dot)
      if (!step) continue            // `test` is the neutral ink-3 token
      const hex = PALETTE[step]
      expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
      for (const g of LIGHT) {
        const got = ratio(hex, g)
        expect(got, `${key}'s dot (${step}) on ${g} is ${got.toFixed(2)}:1, under 3:1`)
          .toBeGreaterThanOrEqual(3)
      }
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })
})
