/**
 * Recurring surface — two standing guards, checked over the source.
 *
 * Splitting the 1795-line page into nine modules made something visible that
 * had been buried: this whole surface was still on the pre-sweep chrome.
 * Nineteen status dots on the 500 ramp, under the 3:1 non-text floor, and six
 * boxed "dot-pills" — a dot and a word inside an `h-5` capsule with
 * `border border-hairline-2 bg-panel px-2`, which is the vetoed shape in the
 * exact classes the design language names.
 *
 * Pinning nineteen individual call sites would be nineteen assertions that
 * rot the moment a span moves. These read the files instead, so the guard
 * covers code that does not exist yet — which is the only way a sweep like
 * this stays swept.
 *
 * Both are deliberately narrow. The dot rule looks only at `rounded-full`
 * spans (a 500 step elsewhere, on a chart series or a hover state, is not a
 * status dot). The pill rule looks only for the full vetoed class run, not
 * for `bg-panel` or a border on their own, which are ordinary and everywhere.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))        // …/recurring/__tests__
const SRC = join(DIR, '..')                                 // …/recurring
const PAGE = join(SRC, '..', '..', 'pages', 'Recurring.jsx')

const files = [
  ...readdirSync(SRC).filter(f => /\.jsx?$/.test(f)).map(f => join(SRC, f)),
  PAGE,
]
const read = (f) => readFileSync(f, 'utf8')
const label = (f) => f.slice(f.indexOf('/src/') + 1)

describe('the recurring surface keeps its status dots off the 500 ramp', () => {
  it('finds no bg-<hue>-500 (or gray-400) on a rounded-full span', () => {
    // BB-A11Y-02: amber-500 1.77, emerald-500 2.09, red-500 2.55,
    // gray-400 1.69 — all under the 3:1 non-text floor on this page's grounds.
    const offenders = []
    for (const f of files) {
      const src = read(f)
      src.split('\n').forEach((line, i) => {
        if (!line.includes('rounded-full')) return
        const bad = line.match(/bg-(?:red|rose|amber|yellow|emerald|green|sky|blue|gray|zinc|slate)-(?:400|500)\b/g)
        if (bad) offenders.push(`${label(f)}:${i + 1}  ${bad.join(', ')}`)
      })
      // A multi-line ternary inside one className — the shape that slipped
      // through a line-wise sweep once already.
      for (const m of src.matchAll(/rounded-full \$\{[\s\S]{0,400}?\}/g)) {
        const bad = m[0].match(/bg-(?:red|rose|amber|emerald|gray|zinc|slate)-(?:400|500)\b/g)
        if (bad) offenders.push(`${label(f)} (multi-line class)  ${bad.join(', ')}`)
      }
    }
    expect(offenders, `use the measured SEV_DOT map:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})

describe('the recurring surface has no boxed dot-pills', () => {
  it('finds no dot+word wrapped in a bordered, filled capsule', () => {
    // The owner rejected even the quiet boxed version ("those little
    // bubbles") in Oct 2026: status recedes into the text as a bare dot and a
    // word. A transient hover tint is fine — it is the RESTING fill and
    // border that are the problem, which is why this matches both together.
    const offenders = []
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => {
        if (line.includes('around a dot')) return          // the comment explaining the fix
        const boxed = /border-hairline-2[^"'`]*bg-panel[^"'`]*px-2|bg-panel[^"'`]*border-hairline-2[^"'`]*px-2/.test(line)
        const capsule = /\bh-5\b[^"'`]*\brounded-(?:sm|md|full)\b/.test(line)
        if (boxed && (capsule || line.includes('gap-1.5'))) {
          offenders.push(`${label(f)}:${i + 1}`)
        }
      })
    }
    expect(offenders, `status is a bare dot + word:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})

describe('the guards are actually looking at something', () => {
  it('reads every module in the split, not an empty list', () => {
    // Without this, renaming the directory would make both guards pass by
    // scanning nothing.
    expect(files.length).toBeGreaterThanOrEqual(9)
    expect(files.some(f => f.endsWith('pages/Recurring.jsx'))).toBe(true)
    expect(read(files[0]).length).toBeGreaterThan(0)
  })
})
