/**
 * BB-A11Y-04b — the focus ring, as a default rather than an opt-in.
 *
 * BB-A11Y-04 settled the SHAPE of this app's focus ring: a 2px accent outline
 * at `outline-offset: -2px`, drawn inside the border box because the app's 94
 * `overflow-hidden` ancestors crop anything outside it. What it did not settle
 * was reach. `.bb-focus` is opt-in, and counted across the app only 14 of
 * ~1360 focusable elements had opted in; 1140 carried no focus styling at all.
 *
 * Those 1140 were never literally invisible — they fall back to the browser's
 * own ring. But that ring is exactly what BB-A11Y-04 was written about: drawn
 * outside the border box so the cards crop it, chosen by the UA so it ignores
 * the accent the user picked, and close to unreadable on the dark themes.
 *
 * So the ring is now a base-layer default on everything that takes keyboard
 * focus. This file pins the three things that would quietly undo it.
 *
 * ## Why a contrast test and not just a "the rule exists" test
 *
 * A focus indicator is a non-text graphical object, so WCAG puts it at 3:1 —
 * the same floor as the status dots in `boardToneContrast.test.js`. The ring
 * is `rgb(var(--accent-500))`, and the accent is a USER CHOICE: seven
 * `body.accent-*` blocks, each of which can be worn on any of the themes,
 * whose grounds are set independently. That is 7 x 6 pairs, and nobody picking
 * a new accent is going to check 24 ratios by hand. Amber is the one that
 * always needs watching — `amber-500` measures 1.74:1 as a status dot — and
 * `--accent-amber`'s own 500 step is the reason this test exists rather than a
 * comment saying "accents should be dark enough".
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')
const css = readFileSync(join(SRC, 'index.css'), 'utf8')

const GROUNDS = ['--panel', '--bg', '--bg-2', '--bg-3']
/** Non-text floor. A focus ring is a graphical object, not a word. */
const MIN_RATIO = 3

/**
 * Brace-matched block bodies, for the reason publicSurface.test.js documents:
 * these rules sit inside `@layer base { … }`, so a `[^}]*` body stops at the
 * first nested closing brace and the test passes vacuously.
 */
function blocksDeclaring(token) {
  return blocksDeclaringRaw(token, /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6}|\d+\s+\d+\s+\d+)\s*;/g)
}

/** Same walk, but keeping `var(--accent-700)`-shaped values too. */
function blocksDeclaringRaw(token, decl = /(--[\w-]+)\s*:\s*([^;{}]+);/g) {
  const out = []
  // Two things the obvious regex gets wrong, both of which cost a wrong answer
  // on the first run of this file:
  //   - a selector LIST wraps lines here (`body.theme-console,\n
  //     body.theme-neon {`), so a `[^\n{}]` capture silently keeps only the
  //     last line and `body.mode-clean.theme-console` then matched the wrong
  //     step. The capture has to allow newlines.
  //   - the anchor has to stay a LINE start. Anchoring on the preceding
  //     `{`/`}`/`;` looks more correct and drops the first block of every
  //     layer: `@layer base {` consumes its own brace, so `:root` right after
  //     it has no delimiter left to match against, and `:root` and
  //     `.public-surface` both vanished from the measurement.
  // Comments are stripped first (as themeTokenIndirection.test.js does) so the
  // long prose blocks in this stylesheet cannot be read as selectors.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /(?:^|\n)\s*([^{};]+?)\s*\{/g
  let m
  while ((m = re.exec(src)) !== null) {
    const selector = m[1].trim()
    if (!selector || selector.startsWith('@')) continue
    const open = src.indexOf('{', m.index + m[0].length - 1)
    let depth = 0, end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    const body = src.slice(open, end)
    const tokens = {}
    // Strip nested blocks: a declaration inside `@media` or a child rule is
    // not this block's own.
    for (const [, name, value] of body.replace(/\{[^{}]*\}/g, '').matchAll(new RegExp(decl.source, 'g'))) {
      if (!(name in tokens)) tokens[name] = value.trim()
    }
    if (tokens[token]) out.push({ selector, tokens })
  }
  return out
}

const channel = (v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
/** Accepts both token spellings: `#rrggbb` grounds and `r g b` accent triples. */
function luminance(value) {
  const rgb = value.startsWith('#')
    ? [0, 2, 4].map((i) => parseInt(value.slice(1).slice(i, i + 2), 16))
    : value.trim().split(/\s+/).map(Number)
  const [r, g, b] = rgb.map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('BB-A11Y-04b: the focus ring reaches the whole app', () => {
  /**
   * The global rule, found by walking BACK from `):focus-visible` to its own
   * opening `:where(`.
   *
   * A forward `:where\(([\s\S]*?)\):focus-visible` looks right and is not: the
   * first `:where(` in this file belongs to `@custom-variant dark`, 800 lines
   * earlier, so the lazy match spans most of the stylesheet and then "finds" a
   * nested `:where` inside its own capture. It cost a false failure on the
   * first run, which is the only reason this is a function.
   */
  function globalRule() {
    const at = css.indexOf('):focus-visible')
    if (at === -1) return null
    const open = css.lastIndexOf(':where(', at)
    if (open === -1) return null
    const brace = css.indexOf('{', at)
    return {
      selector: css.slice(open + ':where('.length, at),
      body: css.slice(brace + 1, css.indexOf('}', brace)),
    }
  }

  it('is a base-layer default, not an opt-in', () => {
    const rule = globalRule()
    expect(rule, 'the global :where(…):focus-visible rule is gone').toBeTruthy()

    // Zero specificity is the whole point: a component that wants its own
    // treatment must be able to win without an !important or a longer selector.
    expect(rule.selector.includes(':where('), 'nested :where would change specificity').toBe(false)

    // The ring must stay INSIDE the border box. A positive offset — or none —
    // puts it back where overflow-hidden crops it, which is the bug.
    const offset = rule.body.match(/outline-offset:\s*(-?[\d.]+)px/)
    expect(offset, 'no outline-offset — the ring would sit outside the box').toBeTruthy()
    expect(Number(offset[1]), 'outline-offset must be negative (BB-A11Y-04)').toBeLessThan(0)
    // The measured token, never a raw step — a raw step cannot be right on
    // both the light themes and the dark ones. See the third test.
    expect(rule.body).toMatch(/outline:\s*2px solid rgb\(var\(--accent-focus\)\)/)
  })

  it('holds .bb-focus to the same two rules', () => {
    // The opt-in utility BB-A11Y-04 added, which had no test of its own — the
    // first mutation run here changed ITS offset and nothing noticed. The two
    // rules have to agree or the app has two focus treatments again, and the
    // one on the dashboard is the one a reviewer sees first.
    const m = css.match(/\.bb-focus:focus-visible\s*\{([\s\S]*?)\}/)
    expect(m, '.bb-focus is gone').toBeTruthy()
    const offset = m[1].match(/outline-offset:\s*(-?[\d.]+)px/)
    expect(offset, '.bb-focus has no outline-offset').toBeTruthy()
    expect(Number(offset[1]), '.bb-focus offset must be negative').toBeLessThan(0)
    expect(m[1]).toMatch(/outline:\s*2px solid rgb\(var\(--accent-focus\)\)/)
  })

  it('covers every element that actually takes keyboard focus', () => {
    const { selector } = globalRule()
    // `a` and `area` without href are not focusable, so they are named with the
    // attribute rather than bare. A negative tabindex is focusable only
    // programmatically — the two dialog containers in components/ui rely on
    // that, and a ring around a whole dialog is noise, not a cue.
    for (const needed of ['a[href]', 'button', 'input', 'select', 'textarea',
                          'summary', '[tabindex]:not([tabindex^="-"])']) {
      expect(selector, `${needed} is missing from the focus-visible selector`).toContain(needed)
    }
  })

  /**
   * `--accent-focus` is declared on `body` (light) and overridden on the dark
   * themes, as `var(--accent-N)`. To measure a theme we need the N its own
   * block resolves to — the nearest declaration that applies to it.
   */
  function focusStepFor(themeSelector) {
    let step = null
    for (const b of blocksDeclaringRaw('--accent-focus')) {
      // `body` matches every theme; `body.theme-console` only its own, and
      // being later and more specific it wins. `.public-surface` is matched by
      // name because it is a descendant, not a body class.
      const names = b.selector.split(',').map(s => s.trim())
      const applies = names.some(n =>
        n === 'body' ||
        themeSelector === n ||
        (themeSelector.startsWith('body.') && n.startsWith('body.') &&
         n.slice(5).split('.').every(c => themeSelector.slice(5).split('.').includes(c))) ||
        (themeSelector === '.public-surface' && n === '.public-surface'))
      if (applies) {
        const m = b.tokens['--accent-focus'].match(/var\(\s*(--accent-\d{3})\s*\)/)
        if (m) step = m[1]
      }
    }
    return step
  }

  it('declares the ring step on body, not :root, so it follows the accent', () => {
    // The trap this avoids: a `var()` inside a custom property is substituted
    // on the element the DECLARATION applies to. The accent ramp is redefined
    // by `body.accent-*`, one level below `:root`, so a `:root` declaration
    // resolves against the default ramp and inherits that result down — the
    // ring would stay indigo whatever accent the user picked.
    const owners = blocksDeclaringRaw('--accent-focus').map(b => b.selector)
    expect(owners.length, '--accent-focus is not declared anywhere').toBeGreaterThan(0)
    for (const sel of owners) {
      for (const one of sel.split(',').map(s => s.trim())) {
        expect(one === ':root', `--accent-focus on ${one} cannot follow body.accent-*`).toBe(false)
      }
    }
  })

  it('clears the 3:1 non-text floor for every accent on every theme', () => {
    const accents = blocksDeclaring('--accent-500')
    const themes = blocksDeclaring('--ink-3')
    // :root plus six named accents; the themes come from inkContrast's set.
    expect(accents.length, 'accent blocks were not parsed').toBeGreaterThanOrEqual(7)
    expect(themes.length, 'theme blocks were not parsed').toBeGreaterThanOrEqual(6)

    const failures = []
    let checked = 0
    for (const t of themes) {
      const step = focusStepFor(t.selector)
      expect(step, `no --accent-focus resolves for ${t.selector}`).toBeTruthy()
      for (const a of accents) {
        if (!a.tokens[step]) continue
        for (const g of GROUNDS) {
          if (!t.tokens[g]) continue
          checked += 1
          const ratio = contrast(a.tokens[step], t.tokens[g])
          if (ratio < MIN_RATIO) {
            failures.push(
              `${a.selector} ring ${step} (${a.tokens[step]}) on ` +
              `${t.selector} ${g} ${t.tokens[g]} = ${ratio.toFixed(2)}:1`)
          }
        }
      }
    }
    expect(checked, 'nothing was actually measured').toBeGreaterThan(80)
    expect(failures,
      `A focus ring under ${MIN_RATIO}:1 is a focus ring a keyboard user ` +
      `cannot find. No single step serves both ends — 500 clears dark at 3.46 ` +
      `and fails light at 1.69; 700 is the reverse; 600 fails both — so move ` +
      `the step for the theme that fails, not for all of them:\n  ` +
      failures.join('\n  ')).toEqual([])
  })
})
