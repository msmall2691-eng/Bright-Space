/**
 * BB-A11Y-02 — the board's status ramp must clear its floors in both themes.
 *
 * "Status is a dot and a word" is the app's core vocabulary, and in the default
 * light skin both halves of it were below standard. Measured as the worst of
 * the four grounds a board card actually sits on — panel, bg, bg-2, bg-3 —
 * rather than panel alone, which is what made this look like a near-miss:
 *
 *   dots, 3:1 non-text floor      words, 4.5:1 text floor
 *   bg-amber-500    1.74 FAIL     text-amber-600    2.58 FAIL
 *   bg-emerald-500  2.06 FAIL     text-emerald-600  3.05 FAIL
 *   bg-rose-500     2.98 FAIL     text-rose-600     3.81 FAIL
 *   bg-blue-500     2.98 FAIL     text-blue-600     4.19 FAIL
 *   bg-violet-500   3.43 pass     text-violet-600   4.62 pass
 *
 * Only violet passed either floor. Console was fine throughout (dots
 * 3.65-7.19, the 300 steps 8.17-10.71), so this is a light-theme fix and the
 * dark partners are left alone.
 *
 * The chosen steps differ per hue deliberately. Equal ramp positions are not
 * equal luminance, so a uniform "use the 700" rule leaves amber at 4.07 and
 * emerald at 4.44 — both still short. The design system darkened money-ink off
 * its ramp position for exactly this reason.
 *
 * Scope: this covers the FOUR TONE MAPS in components/board/tokens.js. The
 * ~900 raw status classes still inline across the app are a separate
 * migration — `bg-amber-500` is sometimes a watch status and sometimes
 * decoration, so it needs judgement rather than a sweep.
 *
 * If this fails: move the STEP, don't invent a hex. Picking a deeper rung keeps
 * the hue's character and keeps the dot and the word in the same family.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Every file that spells out a measured tone map.
 *
 * There are two, and they cannot be collapsed into one shared variable:
 * Tailwind's JIT only emits classes it can see as COMPLETE literal strings, so
 * `bg-${hue}-700` is purged from the build and the dot renders transparent.
 * The literals therefore have to be repeated, and measurement — this file,
 * reading both — is what keeps them honest instead.
 */
const SOURCES = [
  join(here, '..', 'components', 'board', 'tokens.js'),
  join(here, '..', 'theme', 'statusDots.js'),
].map(p => readFileSync(p, 'utf8'))
const tokens = SOURCES.join('\n')
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')

/** Tailwind's stock palette for the hues the board uses. Only `indigo` is
 *  remapped onto --accent-* in this repo, so these are the literal values the
 *  build emits; indigo/ink/link entries resolve through CSS vars instead and
 *  are covered by accentLinkContrast and inkContrast. */
const PALETTE = {
  'rose-300': '#fda4af', 'rose-400': '#fb7185', 'rose-500': '#f43f5e', 'rose-600': '#e11d48', 'rose-700': '#be123c',
  'amber-300': '#fcd34d', 'amber-400': '#fbbf24', 'amber-500': '#f59e0b', 'amber-600': '#d97706', 'amber-700': '#b45309', 'amber-800': '#92400e',
  'emerald-300': '#6ee7b7', 'emerald-400': '#34d399', 'emerald-500': '#10b981', 'emerald-600': '#059669', 'emerald-700': '#047857', 'emerald-800': '#065f46',
  'blue-300': '#93c5fd', 'blue-400': '#60a5fa', 'blue-500': '#3b82f6', 'blue-600': '#2563eb', 'blue-700': '#1d4ed8',
  'violet-300': '#c4b5fd', 'violet-400': '#a78bfa', 'violet-500': '#8b5cf6', 'violet-600': '#7c3aed', 'violet-700': '#6d28d9',
}

/** Classes that resolve through a CSS var, so another test owns them. */
const TOKEN_BASED = /-(ink|ink-2|ink-3|link|panel|hairline)(-|$)/

const GROUND_NAMES = ['--panel', '--bg', '--bg-2', '--bg-3']

/** Grounds declared by a theme block, brace-matched for the reason
 *  publicSurface.test.js documents. */
function grounds(selectorStartsWith) {
  const found = {}
  let i = 0
  while ((i = css.indexOf(selectorStartsWith, i)) !== -1) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    if (!/^[\w\s.,:#[\]()="'-]*$/.test(css.slice(i + selectorStartsWith.length, open))) {
      i += selectorStartsWith.length; continue
    }
    let depth = 0, end = open
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++
      else if (css[end] === '}' && --depth === 0) break
    }
    for (const [, name, hex] of css.slice(open, end).matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
      if (GROUND_NAMES.includes(name) && !(name in found)) found[name] = hex
    }
    i = end
  }
  return Object.values(found)
}

const LIGHT = grounds('body.mode-clean')
const DARK = grounds('body.mode-clean.theme-console')

function rgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}
function chan(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function lum([r, g, b]) {
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
function ratio(a, b) {
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The `name: 'classes'` entries of an exported map in tokens.js. */
function mapEntries(name) {
  const m = tokens.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`))
  if (!m) return []
  return [...m[1].matchAll(/(\w+):\s*'([^']*)'/g)].map(([, key, classes]) => ({ key, classes }))
}

/** Split a class string into its light value and its `dark:` value. */
function split(classes) {
  const light = []
  const dark = []
  for (const c of classes.split(/\s+/).filter(Boolean)) {
    if (c.startsWith('dark:')) dark.push(c.slice(5))
    else light.push(c)
  }
  return { light, dark }
}

function hexOf(cls) {
  const step = cls.replace(/^(bg|text)-/, '')
  return PALETTE[step] || null
}

const MAPS = [
  { name: 'TAG_TONE', floor: 4.5, what: 'a status WORD' },
  { name: 'STAT_TONE', floor: 4.5, what: 'a stat-tile number' },
  { name: 'SEV_DOT', floor: 3, what: 'a severity DOT' },
  { name: 'INT_DOT', floor: 3, what: 'an integration DOT' },
  { name: 'FOCUS_DOT', floor: 3, what: "the focus bar's DOT" },
  // theme/statusDots.js — the app-wide dot, not just the board's. Same 3:1
  // non-text floor: a dot carries meaning but is not text.
  { name: 'STATUS_DOT', floor: 3, what: 'the app-wide status DOT' },
]

describe('BB-A11Y-02 — the board tone maps clear their floors', () => {
  it('parsed the maps and both themes at all', () => {
    expect(LIGHT.length, 'no light grounds parsed from index.css').toBeGreaterThan(2)
    expect(DARK.length, 'no console grounds parsed from index.css').toBeGreaterThan(2)
    // >= 2 rather than > 2: the guard exists to catch a tokens.js shape change
    // that makes the parse come back EMPTY (which would turn every assertion
    // below into a silent no-op). FOCUS_DOT genuinely has two entries.
    for (const { name } of MAPS) {
      expect(mapEntries(name).length, `${name} did not parse — tokens.js shape changed`).toBeGreaterThanOrEqual(2)
    }
  })

  for (const { name, floor, what } of MAPS) {
    for (const { key, classes } of mapEntries(name)) {
      if (TOKEN_BASED.test(classes)) continue
      const { light, dark } = split(classes)

      it(`${name}.${key} — ${what}`, () => {
        for (const cls of light) {
          const hex = hexOf(cls)
          if (!hex) continue
          for (const g of LIGHT) {
            const got = ratio(hex, g)
            expect(got, `${cls} on ${g} (light) is ${got.toFixed(2)}:1, under ${floor}:1`)
              .toBeGreaterThanOrEqual(floor)
          }
        }
        for (const cls of dark) {
          const hex = hexOf(cls)
          if (!hex) continue
          for (const g of DARK) {
            const got = ratio(hex, g)
            expect(got, `dark:${cls} on ${g} (console) is ${got.toFixed(2)}:1, under ${floor}:1`)
              .toBeGreaterThanOrEqual(floor)
          }
        }
      })

      it(`${name}.${key} has a dark partner where it needs one`, () => {
        // A single value has to clear BOTH themes. Where it cannot, the entry
        // must carry a `dark:` variant — that absence is what made the 500s
        // fail in light for years while looking fine in Console.
        if (dark.length) return
        for (const cls of light) {
          const hex = hexOf(cls)
          if (!hex) continue
          for (const g of DARK) {
            const got = ratio(hex, g)
            expect(got, `${cls} has no dark: partner and is ${got.toFixed(2)}:1 on ${g} in Console`)
              .toBeGreaterThanOrEqual(floor)
          }
        }
      })
    }
  }
})
