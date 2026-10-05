/**
 * BB-A11Y-01 — the tertiary ink must stay readable in every theme.
 *
 * `--ink-3` is the app's quietest text colour: column labels, metadata,
 * timestamps, the sub-line under a stat tile's number. There are ~1800
 * `text-ink-3` uses and essentially all of them are small text, so it is the
 * single highest-traffic contrast risk in the product.
 *
 * Every theme shipped it BELOW WCAG AA 4.5:1 against its own surfaces — clean
 * was the worst at 2.65:1 on `--bg-3`, and even Neon only reached 4.10:1. The
 * failure was invisible in review because a muted grey looks correct next to
 * darker text; nothing about it reads as broken until someone tries to read a
 * timestamp in daylight on an iPad.
 *
 * This asserts the CONTRACT, not the six literals: for every theme block that
 * declares `--ink-3`, the ratio against each ground that block declares
 * (`--panel` / `--bg` / `--bg-2` / `--bg-3`) must clear 4.5:1. A new theme, a
 * retuned surface, or someone lightening the ink back by eye all fail here
 * rather than in front of a customer.
 *
 * If this fails: don't nudge the ink until the number passes by luck. Scale the
 * ORIGINAL hue in linear-light until it clears every ground, which is how the
 * current values were derived — that keeps the hue and the theme's character.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')

const GROUNDS = ['--panel', '--bg', '--bg-2', '--bg-3']
const MIN_RATIO = 4.5

/** Hex declarations inside each block that declares `--ink-3`.
 *
 *  Brace-matched, for the reason publicSurface.test.js documents: these rules
 *  live inside `@layer base { … }`, so a `[^}]*` body stops at the first
 *  nested closing brace and the test would pass vacuously. */
function themeBlocks() {
  const blocks = []
  const re = /(^|\n)\s*([^\n{}]*?)\s*\{/g
  let m
  while ((m = re.exec(css)) !== null) {
    const selector = m[2].trim()
    if (!selector || selector.startsWith('@') || selector.startsWith('/*')) continue
    const open = css.indexOf('{', m.index + m[0].length - 1)
    let depth = 0
    let end = open
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++
      else if (css[end] === '}' && --depth === 0) break
    }
    const body = css.slice(open, end)
    const tokens = {}
    for (const [, name, hex] of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
      // First declaration wins, matching the cascade within one block.
      if (!(name in tokens)) tokens[name] = hex
    }
    if (tokens['--ink-3']) blocks.push({ selector, tokens })
  }
  return blocks
}

const channel = (v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('BB-A11Y-01: --ink-3 clears WCAG AA in every theme', () => {
  const blocks = themeBlocks()

  it('finds every theme block that declares --ink-3', () => {
    // paper (:root), console, clean, clean+console, neon, public-surface.
    expect(blocks.length).toBeGreaterThanOrEqual(6)
  })

  it('is at least 4.5:1 against every ground its own theme declares', () => {
    const failures = []
    let checked = 0
    for (const { selector, tokens } of blocks) {
      for (const ground of GROUNDS) {
        const bg = tokens[ground]
        if (!bg) continue
        checked += 1
        const ratio = contrast(tokens['--ink-3'], bg)
        if (ratio < MIN_RATIO) {
          failures.push(
            `${selector}: --ink-3 ${tokens['--ink-3']} on ${ground} ${bg} = ${ratio.toFixed(2)}:1`
          )
        }
      }
    }
    expect(checked).toBeGreaterThan(12) // the grounds were actually parsed
    expect(failures, `below ${MIN_RATIO}:1 —\n${failures.join('\n')}`).toEqual([])
  })

  it('keeps ink-3 distinguishable from ink-2, so the hierarchy survives', () => {
    // The fix darkens ink-3 in light themes; if it ever lands on top of ink-2
    // the three-step text hierarchy collapses into two.
    for (const { selector, tokens } of blocks) {
      if (!tokens['--ink-2']) continue
      const step = contrast(tokens['--ink-3'], tokens['--ink-2'])
      expect(step, `${selector}: ink-2 and ink-3 are visually identical`).toBeGreaterThan(1.15)
    }
  })
})
