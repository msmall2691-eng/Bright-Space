/**
 * The route manifest vs. the router.
 *
 * A page can be built, routed, tested and shipped while being reachable from
 * nowhere — Tidy Up sat like that: 397 lines of working duplicate-client and
 * duplicate-property merging, in no menu, linked only from one buried line in
 * Settings → General. Nothing failed. It was just invisible.
 *
 * This reads App.jsx and asserts every route that renders a real page is
 * reachable from the sidebar, its tabs, the quick actions, or an explicit
 * "not in the nav on purpose" list. Redirect routes (old URLs kept alive for
 * bookmarks) don't need a home.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { NAV_SECTIONS, SETTINGS_ITEM, crumbsFor } from '../routes'

const here = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(here, '../../App.jsx'), 'utf8')

/** Paths that render a component, excluding <Navigate> redirects. */
function realRoutes() {
  const out = []
  const re = /<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g
  let m
  while ((m = re.exec(appSource))) {
    const [, path, element] = m
    if (element === 'Navigate') continue        // an old URL kept alive
    if (path.includes(':') || path === '*') continue  // detail + catch-all
    out.push(path)
  }
  return out
}

/** Everywhere a person can get to without typing a URL. */
function reachable() {
  const paths = new Set()
  const add = (to) => to && paths.add(to.split('?')[0])
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      add(item.to)
      for (const tab of item.tabs || []) add(tab.to)
    }
  }
  add(SETTINGS_ITEM.to)
  for (const tab of SETTINGS_ITEM.tabs || []) add(tab.to)
  return paths
}

// Signed-out and customer-facing screens are reached by emailed link, and the
// design system is a developer tool. None of them belong in an operator's nav.
const NOT_IN_NAV = new Set([
  '/', '/login', '/design-system',
  '/quote', '/pay', '/job', '/portal', '/portal/verify', '/accept-invite',
  // The public apply form. Deliberately outside the nav and deliberately
  // outside auth: it's meant to be handed out as a plain link — on a card, in
  // a job ad — to people who have no login and never will unless the office
  // approves them. The office side of it lives in Settings → Users.
  '/apply',
])

describe('every page has a way in', () => {
  it('finds the routes it is supposed to check', () => {
    const routes = realRoutes()
    expect(routes.length).toBeGreaterThan(15)
    expect(routes).toContain('/dashboard')
    expect(routes).toContain('/cleanup')
  })

  it('leaves no page stranded outside the nav', () => {
    const nav = reachable()
    const stranded = realRoutes().filter(
      p => !nav.has(p) && !NOT_IN_NAV.has(p) && !p.startsWith('/portal'))

    // If this fails: either give the page a home in nav/routes.js, or add it
    // to NOT_IN_NAV with a reason. Don't just delete the assertion — the whole
    // point is that shipping an unreachable page should be a deliberate act.
    expect(stranded).toEqual([])
  })

  it('keeps Tidy Up beside the records it cleans up', () => {
    // It merges duplicate clients and duplicate properties, so it belongs
    // under Clients — not buried in Settings, where it was.
    expect(reachable().has('/cleanup')).toBe(true)
    expect(crumbsFor('/cleanup').map(c => c.label)).toEqual(['Clients', 'Tidy Up'])
  })
})

describe('the nav stays small', () => {
  it('is still six rows plus Settings', () => {
    // The owner's words were "not in love with nav bar menus and pages and
    // home it's all just chaos". It went 17 → 7; a regression here is how it
    // creeps back.
    const rows = NAV_SECTIONS.flatMap(s => s.items)
    expect(rows).toHaveLength(6)
    expect(SETTINGS_ITEM.to).toBe('/settings')
  })

  it('gives every destination a label and an icon', () => {
    const all = [...NAV_SECTIONS.flatMap(s => s.items), SETTINGS_ITEM]
    for (const item of all) {
      expect(item.label, item.to).toBeTruthy()
      expect(item.icon, item.to).toBeTruthy()
      for (const tab of item.tabs || []) {
        expect(tab.label, tab.to).toBeTruthy()
        expect(tab.icon, tab.to).toBeTruthy()
      }
    }
  })

  it('never lands a parent row on a page its own tabs do not include', () => {
    // The row and its first tab must agree, or clicking the row shows a tab
    // strip with nothing selected.
    for (const item of NAV_SECTIONS.flatMap(s => s.items)) {
      if (!item.tabs?.length) continue
      expect(item.tabs.map(t => t.to)).toContain(item.to)
    }
  })
})
