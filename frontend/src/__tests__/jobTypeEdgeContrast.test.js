/**
 * BB-A11Y-02 — the job-type EDGE must clear its floor in every theme, and must
 * not drift from the dot it is supposed to match.
 *
 * `boardToneContrast.test.js` measures Tailwind CLASSES. The schedule's edge is
 * not a class and cannot be one: the week block's 3px rule, the dispatch
 * timeline block and the drag ghost are inline-styled on absolutely-positioned
 * elements, so they need a real colour value. That value used to be a literal
 * hex sitting beside the dot class in `components/schedule/constants.js`, with
 * a comment warning the two must move together — which is precisely the kind of
 * pairing nothing was checking.
 *
 * ## Why it is a CSS var rather than a literal
 *
 * One fixed value cannot serve both themes. It has to clear 3:1 against the
 * near-white light grounds AND against Console's near-black ones, and of the
 * whole Tailwind palette only amber-700, rose-600 and slate-500 manage both —
 * there is no distinct categorical trio in that window. So the step is picked
 * per theme in `index.css`, the same answer `--accent-link` reached for the
 * same reason (BB-A11Y-03).
 *
 * ## What this asserts
 *
 * 1. Each var clears 3:1 against its OWN theme's four grounds.
 * 2. Each var equals the hex of the Tailwind step the matching `JOB_TYPE_DOT`
 *    entry uses — so the edge and the dot on one block are one colour, and a
 *    later re-measure that moves the dot has to move the edge with it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')
const scales = readFileSync(join(here, '..', 'theme', 'scheduleScales.js'), 'utf8')

/** Only the steps the edges and their dots actually use. Deliberately small:
 *  a step that is not here makes the step-match assertion fail loudly rather
 *  than skip, which is the opposite of PALETTE's behaviour next door. */
const PALETTE = {
  'amber-400': '#fbbf24', 'amber-700': '#b45309',
  'blue-400': '#60a5fa', 'blue-600': '#2563eb',
  'purple-300': '#d8b4fe', 'purple-800': '#6b21a8',
}

const TYPES = ['str', 'residential', 'commercial']
const GROUND_NAMES = ['--panel', '--bg', '--bg-2', '--bg-3']

/** Brace-matched block bodies for a selector, for the reason publicSurface
 *  documents: these rules live inside `@layer base { … }` and a `[^}]*` slice
 *  stops at the first nested close, finding nothing and passing vacuously. */
function blockBodies(selectorStartsWith) {
  const bodies = []
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
    bodies.push(css.slice(open, end))
    i = end
  }
  return bodies
}

/** The LAST declaration of each name wins, matching the cascade: the light
 *  values are declared on :root and the dark themes override them. */
function declared(selectorStartsWith, pattern) {
  const found = {}
  for (const body of blockBodies(selectorStartsWith)) {
    for (const [, name, hex] of body.matchAll(pattern)) found[name] = hex.toLowerCase()
  }
  return found
}

const edgeDecl = /(--job-edge-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g
const groundDecl = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g

const LIGHT_EDGES = declared(':root', edgeDecl)
const DARK_EDGES = declared('body.theme-console', edgeDecl)
const PUBLIC_EDGES = declared('.public-surface', edgeDecl)

/** Grounds are FIRST-wins, unlike the edge vars above, and the difference is
 *  load-bearing: `body.mode-clean` is a prefix of `body.mode-clean.theme-console`,
 *  so a last-wins read of the light theme hands back Console's near-black
 *  grounds and every light assertion silently measures the wrong thing.
 *  `boardToneContrast` takes the same first-wins route for the same reason. */
function grounds(selectorStartsWith) {
  const found = {}
  for (const body of blockBodies(selectorStartsWith)) {
    for (const [, name, hex] of body.matchAll(groundDecl)) {
      if (GROUND_NAMES.includes(name) && !(name in found)) found[name] = hex.toLowerCase()
    }
  }
  return GROUND_NAMES.map(n => found[n]).filter(Boolean)
}
const LIGHT_GROUNDS = grounds('body.mode-clean')
const DARK_GROUNDS = grounds('body.mode-clean.theme-console')

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

/** `key: 'classes'` out of an exported map in scheduleScales.js. */
function mapEntries(name) {
  const m = scales.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`))
  if (!m) return {}
  return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']*)'/g)].map(([, k, v]) => [k, v]))
}
const DOTS = mapEntries('JOB_TYPE_DOT')
const EDGES = mapEntries('JOB_TYPE_EDGE')

describe('BB-A11Y-02 — the job-type edge', () => {
  it('parsed the css and the scale file at all', () => {
    // Non-vacuity. Every assertion below iterates something parsed out of a
    // file; a parse that silently came back empty would make them all pass.
    expect(LIGHT_GROUNDS.length, 'no light grounds parsed').toBe(4)
    expect(DARK_GROUNDS.length, 'no console grounds parsed').toBe(4)
    expect(Object.keys(DOTS)).toEqual(TYPES)
    expect(Object.keys(EDGES)).toEqual(TYPES)
  })

  for (const type of TYPES) {
    const varName = `--job-edge-${type}`

    it(`${varName} is declared for light, dark and public`, () => {
      // The public reset is the publicSurface contract: a dark-theme viewer
      // opening a public page would otherwise carry the light step onto it.
      expect(LIGHT_EDGES[varName], `${varName} missing from :root`).toBeTruthy()
      expect(DARK_EDGES[varName], `${varName} missing from the dark themes`).toBeTruthy()
      expect(PUBLIC_EDGES[varName], `${varName} missing from .public-surface`).toBeTruthy()
    })

    it(`${varName} clears 3:1 in both themes`, () => {
      for (const g of LIGHT_GROUNDS) {
        const got = ratio(LIGHT_EDGES[varName], g)
        expect(got, `${varName} ${LIGHT_EDGES[varName]} on ${g} (light) is ${got.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(3)
      }
      for (const g of DARK_GROUNDS) {
        const got = ratio(DARK_EDGES[varName], g)
        expect(got, `${varName} ${DARK_EDGES[varName]} on ${g} (console) is ${got.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(3)
      }
    })

    it(`${varName} is the same colour as the ${type} dot`, () => {
      // The pairing the old `hex: '#F59E0B'` comment asked for in prose and
      // nothing enforced. Both halves render on the SAME block — the 3px rule
      // down its left edge and the dot inside it — so a step that moves on one
      // and not the other is visible immediately and was easy to miss.
      const [light, dark] = ['', 'dark:'].map(prefix =>
        DOTS[type].split(/\s+/).find(c => c.startsWith(`${prefix}bg-`)).replace(`${prefix}bg-`, ''),
      )
      expect(PALETTE[light], `scheduleScales JOB_TYPE_DOT.${type} uses ${light}, which this test has no hex for`).toBeTruthy()
      expect(PALETTE[dark], `scheduleScales JOB_TYPE_DOT.${type} uses dark ${dark}, which this test has no hex for`).toBeTruthy()
      expect(LIGHT_EDGES[varName], `${varName} drifted from the ${type} dot (${light})`).toBe(PALETTE[light])
      expect(DARK_EDGES[varName], `${varName} drifted from the dark ${type} dot (${dark})`).toBe(PALETTE[dark])
      expect(PUBLIC_EDGES[varName], `.public-surface ${varName} must hold the LIGHT step`).toBe(PALETTE[light])
    })

    it(`JOB_TYPE_EDGE.${type} points at ${varName}`, () => {
      // The JS side has to name the var the CSS declares; a typo renders the
      // border transparent, which no contrast check would ever catch.
      expect(EDGES[type]).toBe(`var(${varName})`)
    })
  }

  it('the three edges stay distinguishable from each other', () => {
    // Job type is a categorical scale, so the failure that matters is two
    // types looking alike — not a step being too light. Measured as a plain
    // luminance spread here; the full CVD check lives with the dot palette.
    for (const edges of [LIGHT_EDGES, DARK_EDGES]) {
      for (let i = 0; i < TYPES.length; i++) {
        for (let j = i + 1; j < TYPES.length; j++) {
          const a = edges[`--job-edge-${TYPES[i]}`]
          const b = edges[`--job-edge-${TYPES[j]}`]
          expect(a, `${TYPES[i]} and ${TYPES[j]} are the same colour (${a})`).not.toBe(b)
        }
      }
    }
  })
})
