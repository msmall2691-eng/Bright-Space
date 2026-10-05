/**
 * BB-A11Y-02 — the stat VALUE on a page header must clear the text floor.
 *
 * `PageTitle`'s stats line is the "Label **value** · Label **value**" strip
 * under a page title, and the bold value is the one thing on that line you are
 * meant to read. Its colour comes from one shared `toneClass`, so a single
 * wrong step was wrong on every page that passes a tone — Requests, Deals,
 * Properties, Marketplace, Quoting, Clients, Schedule and the board.
 *
 * Measured as the worst of the four grounds a header sits on (panel / bg /
 * bg-2 / bg-3), the 600s were all under 4.5:1:
 *
 *   amber-600 2.58    emerald-600 3.05    red-600 3.99
 *
 * This file pins the computed ratio rather than the class name, so moving a
 * step is allowed and dropping below the floor is not.
 *
 * `toneClass` also NORMALISES the legacy Tailwind-ish strings callers still
 * pass (`tone: 'text-amber-300'`), which is why fixing it here is enough —
 * a raw 300 never reaches the DOM. That normalisation is pinned too, because
 * if it ever stopped, `text-amber-300` would render at 1.19:1.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, cleanup, afterEach } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PageTitle from '../PageTitle'

afterEach?.(cleanup)

/** Tailwind steps this file reasons about. */
const PALETTE = {
  'emerald-300': '#6ee7b7', 'emerald-600': '#059669', 'emerald-700': '#047857', 'emerald-800': '#065f46',
  'amber-300': '#fcd34d', 'amber-600': '#d97706', 'amber-700': '#b45309', 'amber-800': '#92400e',
  'red-300': '#fca5a5', 'red-600': '#dc2626', 'red-700': '#b91c1c',
}
/** The four grounds a page header can sit on in the light skin. */
const LIGHT = ['#ffffff', '#f7f7f8', '#f1f1f3', '#e9e9ec']

const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1).slice(i, i + 2), 16))
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

/** The classes PageTitle put on the bold value for this tone. */
function valueClassFor(tone) {
  cleanup()
  render(
    <MemoryRouter>
      <PageTitle title="T" stats={[{ label: 'Open', value: '7', tone }]} />
    </MemoryRouter>,
  )
  return screen.getByText('7').className
}

/** The light-mode step in a "text-x-800 dark:text-x-300" pair. */
function lightStep(cls) {
  const m = cls.match(/(?:^|\s)text-((?:emerald|amber|red|rose|orange)-\d{3})\b/)
  return m ? m[1] : null
}

describe('PageTitle stats — the value clears the text floor', () => {
  for (const [name, tone] of [
    ['good', 'good'], ['warn', 'warn'], ['bad', 'bad'],
    // The legacy strings real pages still pass.
    ['legacy emerald', 'text-emerald-300'],
    ['legacy amber', 'text-amber-300'],
    ['legacy red', 'text-red-300'],
  ]) {
    it(`${name} is readable on every light ground`, () => {
      const step = lightStep(valueClassFor(tone))
      expect(step, `no light step parsed from the ${name} tone`).toBeTruthy()
      const hex = PALETTE[step]
      expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
      for (const ground of LIGHT) {
        const got = ratio(hex, ground)
        expect(got, `text-${step} on ${ground} is ${got.toFixed(2)}:1, under 4.5:1`)
          .toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('normalises a legacy 300 rather than rendering it', () => {
    // The guard that makes fixing one function enough: `text-amber-300` renders
    // at 1.19:1 against white. It must never reach the DOM as the light step.
    const cls = valueClassFor('text-amber-300')
    expect(lightStep(cls)).not.toBe('amber-300')
    expect(cls).toContain('dark:text-amber-300')   // the dark partner is fine
  })

  it('leaves an untoned value in plain ink', () => {
    expect(valueClassFor(undefined)).toContain('text-ink')
  })
})
