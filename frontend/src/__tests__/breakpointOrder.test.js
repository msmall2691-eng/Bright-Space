/**
 * BB-CSS-01 — the breakpoint scale must sort, or `shell:` silently loses.
 *
 * Tailwind orders min-width variants by comparing their values. `shell` was
 * declared as the only px value on an otherwise rem scale (sm 40rem, md 48rem,
 * …), so there was nothing to compare it against: the order fell back to
 * declaration order and `shell`'s @media block was emitted BEFORE sm's and
 * md's. Same specificity + earlier in the stylesheet meant that at every width
 * >= 900px, `sm:` beat `shell:` for any property both of them set.
 *
 * It cost the board its layout. `shell:grid-cols-[1.5fr_1.15fr_1.15fr]` sat in
 * the DOM, overruled by the `sm:grid-cols-2` beside it, so the three-column
 * bento never rendered at any width and the comms rail spilled underneath as a
 * full-width band. Nothing errored and the class was right there in the markup,
 * which is exactly why it survived: the symptom looks like a design choice.
 *
 * The guard is on the DECLARATION rather than the output, because the output is
 * a build artifact and this is a one-line edit away from regressing. Px, not
 * rem, on purpose: `shell` is pinned to a physical window (~940px, 40px of
 * headroom) and a rem scale moves it under browser zoom.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')

const declared = [...css.matchAll(/--breakpoint-([\w-]+):\s*([\d.]+)(px|rem)\s*;/g)]
  .map(m => ({ name: m[1], value: Number(m[2]), unit: m[3] }))

describe('breakpoint scale', () => {
  it('declares every breakpoint, including shell', () => {
    expect(declared.map(b => b.name)).toEqual(['sm', 'md', 'shell', 'lg', 'xl', '2xl'])
  })

  it('uses one unit throughout, so the values can be compared', () => {
    // A mixed scale is the bug: Tailwind cannot order 900px against 40rem.
    expect([...new Set(declared.map(b => b.unit))]).toEqual(['px'])
  })

  it('declares them in ascending order', () => {
    const values = declared.map(b => b.value)
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('puts shell after sm and md, and before lg', () => {
    const at = name => declared.findIndex(b => b.name === name)
    expect(at('sm')).toBeLessThan(at('shell'))
    expect(at('md')).toBeLessThan(at('shell'))
    expect(at('shell')).toBeLessThan(at('lg'))
    // The owner's window is ~940px. This number is a measurement, not a taste.
    expect(declared.find(b => b.name === 'shell').value).toBe(900)
  })
})
