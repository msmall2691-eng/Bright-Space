/**
 * BB-A11Y-03 — accent as TEXT needs a different ramp step from accent as a fill.
 *
 * `text-indigo-600` resolved to `--accent-600`, which is the same value
 * `bg-indigo-600` uses as a FILL under white ink. As a fill that is correct. As
 * text it was below WCAG AA in 170 places — `RecordLink`, the active
 * `BottomNav` tab, every `SnapshotBoxes` record link, the `.more` links on the
 * board — and it failed far wider than it looked:
 *
 *     as link text, worst of panel / bg / bg-2 / bg-3
 *     accent     light           console
 *     indigo     5.09 pass       2.46 FAIL
 *     violet     4.62 pass       2.71 FAIL
 *     blue       4.19 FAIL       2.99 FAIL
 *     rose       3.81 FAIL       3.29 FAIL
 *     cyan       2.98 FAIL       4.20 FAIL
 *
 * Only the DEFAULT accent passed, and only in light. That is why it survived
 * review: anyone who picked an accent of their own had failing links in both
 * themes, and the person checking never did.
 *
 * The fix is a token, `--accent-link`: the 800 step in light, the 300 step in
 * dark, both `var()`s into the live ramp so they follow the `body.accent-*`
 * choice for free. This asserts the CONTRACT rather than the literals — a new
 * accent, a retuned surface, or someone pointing `--accent-link` back at
 * `--accent-600` fails here instead of in front of a customer.
 *
 * If this fails: move the STEP, don't nudge a hex. The ramp is Tailwind's and
 * the steps are already perceptually spaced; picking a deeper step keeps the
 * accent's character, while hand-tuning one channel triple desynchronises it
 * from the fill it has to sit beside.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..')
const css = readFileSync(join(src, 'index.css'), 'utf8')

const GROUNDS = ['--panel', '--bg', '--bg-2', '--bg-3']
const MIN_RATIO = 4.5

/** Brace-matched blocks, for the reason publicSurface.test.js documents: these
 *  rules live inside `@layer base { … }`, so a `[^}]*` body stops at the first
 *  nested closing brace and the test would pass vacuously. */
function blocks() {
  const out = []
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
    out.push({ selector, body: css.slice(open, end) })
  }
  return out
}

/** `--accent-NNN: R G B;` channel triples declared in a block. */
function ramp(body) {
  const steps = {}
  for (const [, step, triple] of body.matchAll(/--accent-(\d{2,3})\s*:\s*([\d\s]+?);/g)) {
    if (!(step in steps)) steps[step] = triple.trim().split(/\s+/).map(Number)
  }
  return steps
}

/** `--token: #rrggbb;` declarations in a block. */
function hexes(body) {
  const out = {}
  for (const [, name, hex] of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    if (!(name in out)) out[name] = rgb(hex)
  }
  return out
}

function rgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

function channel(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const all = blocks()

/** Every accent ramp in the file: the `:root` default plus each body.accent-*. */
const ramps = all
  .map(b => ({ selector: b.selector, steps: ramp(b.body) }))
  .filter(r => r.steps['300'] && r.steps['800'])

/** Theme blocks that declare at least one ground, split light vs dark by
 *  whether `--accent-link` resolves to the 300 step for that selector. */
const themes = all
  .map(b => ({ selector: b.selector, tokens: hexes(b.body) }))
  .filter(t => GROUNDS.some(g => t.tokens[g]))

const DARK = /theme-console|theme-neon/

describe('BB-A11Y-03 — accent-as-text clears AA for every accent in every theme', () => {
  it('found the ramps and the theme grounds at all', () => {
    expect(ramps.length, 'no --accent-* ramps parsed — the regex has drifted').toBeGreaterThan(5)
    expect(themes.length, 'no theme grounds parsed').toBeGreaterThan(2)
  })

  it('wires --color-link through --accent-link, not straight at a ramp step', () => {
    // The indirection is the point: a component says `text-link` and the step
    // is chosen per theme in one place.
    expect(css).toMatch(/--color-link:\s*rgb\(var\(--accent-link\)\)/)
    expect(css, 'light must use a deep step').toMatch(/--accent-link:\s*var\(--accent-800\)/)
    expect(css, 'dark must use a light step').toMatch(/--accent-link:\s*var\(--accent-300\)/)
  })

  for (const theme of themes) {
    const dark = DARK.test(theme.selector)
    const step = dark ? '300' : '800'

    for (const r of ramps) {
      it(`${theme.selector} + ${r.selector} → accent-${step} as text`, () => {
        const ink = r.steps[step]
        for (const ground of GROUNDS) {
          const bg = theme.tokens[ground]
          if (!bg) continue // this block doesn't declare that ground; it inherits
          const got = ratio(ink, bg)
          expect(
            got,
            `accent-${step} on ${ground} in ${theme.selector} is ${got.toFixed(2)}:1, under ${MIN_RATIO}:1`,
          ).toBeGreaterThanOrEqual(MIN_RATIO)
        }
      })
    }
  }
})

describe('BB-A11Y-03 — nothing reintroduces accent-as-text at a fill step', () => {
  /** Every .js/.jsx/.css under src, so a new file cannot quietly reopen this.
   *  Test files are skipped: they name the old class in prose (this one does,
   *  in its own header table) and nothing they contain is ever rendered. */
  function sources(dir = src, acc = []) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) sources(path, acc)
      else if (/\.(jsx?|css)$/.test(name)) acc.push(path)
    }
    return acc
  }

  it('uses text-link, never a text-indigo step that doubles as a fill', () => {
    // text-indigo-100 is allowed: it is light ink ON an indigo fill
    // (MessageBubble's outbound bubble), which is the opposite problem.
    const offenders = []
    for (const path of sources()) {
      const text = readFileSync(path, 'utf8')
      for (const [cls] of text.matchAll(
        /(?:hover:|group-hover:|focus:|dark:)?text-indigo-(?:200|300|400|500|600|700|800|900)/g,
      )) {
        offenders.push(`${path.slice(src.length + 1)}: ${cls}`)
      }
    }
    expect(
      offenders,
      `use text-link / hover:text-link instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })
})
