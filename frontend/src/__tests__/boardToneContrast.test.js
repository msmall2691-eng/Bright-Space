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
  join(here, '..', 'theme', 'statusText.js'),
  join(here, '..', 'theme', 'scheduleScales.js'),
].map(p => readFileSync(p, 'utf8'))
const tokens = SOURCES.join('\n')
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')

/**
 * Tailwind's palette, READ FROM TAILWIND rather than copied out of it.
 *
 * This was 44 hardcoded hexes, and every one of them was wrong. They were
 * Tailwind v3 values; the app is on v4, which re-specified the whole palette
 * in oklch — so for as long as this file has existed it has been measuring a
 * palette the build does not ship.
 *
 * It happened not to matter, which is the uncomfortable part. Converting the
 * emitted oklch back to sRGB and re-measuring, contrast moved by at most 0.21
 * and **no step used by a live map crossed its floor**, so every verdict this
 * file ever gave was still right. The one step that does cross is
 * `emerald-600` — 3.05 under v3, 2.96 under v4, i.e. passing the 3:1 non-text
 * floor on paper and failing it in the browser — and it survives only in doc
 * comments and in two exempted icons that sit on `--panel` specifically,
 * where it measures 3.65.
 *
 * So the fix is not "update the hexes", which would rot again on the next
 * Tailwind release. It is to resolve them from `tailwindcss/theme.css` — the
 * file the build itself reads — so the numbers follow the package version in
 * `package.json` and cannot silently diverge again.
 *
 * `theme.css` rather than `dist/`: it needs no build to have run, it carries
 * every step including ones nothing currently uses (`sky-500` is absent from
 * the built CSS for exactly that reason, and was therefore unmeasurable), and
 * it is what the build derives from.
 *
 * `indigo` is deliberately absent: this repo remaps it onto `--accent-*`, so
 * its real values come from index.css and are covered by accentLinkContrast
 * and inkContrast instead.
 */
const THEME_CSS = readFileSync(
  join(here, '..', '..', 'node_modules', 'tailwindcss', 'theme.css'), 'utf8')

/** oklch(L% C H) -> sRGB, per CSS Color 4. Values outside the sRGB gamut are
 *  clipped per channel, which is what a browser paints. */
function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
    return Math.min(255, Math.max(0, Math.round(c * 255)))
  })
}

const HEX = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')

/** Every `--color-<hue>-<step>` Tailwind defines, as a hex this file can measure. */
const PALETTE = (() => {
  const out = {}
  for (const [, name, L, C, H] of THEME_CSS.matchAll(
    /--color-([a-z]+-\d{2,3}):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)/g)) {
    // `none` is a MISSING hue, which Tailwind uses for the achromatic ramps
    // (`--color-neutral-100: oklch(97% 0 none)`). Chroma is 0 there so the hue
    // cannot affect the result, but the regex has to accept it or 13 greys go
    // unresolved — and an unresolved step is one the floors never check.
    out[name] = HEX(oklchToRgb(Number(L) / 100, Number(C), H === 'none' ? 0 : Number(H)))
  }
  return out
})()

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
  // theme/statusText.js. The two floors are the whole reason these are two
  // maps: the same `text-amber-600` is 2.58:1, which fails as text AND as an
  // icon, and the fix is a different step for each.
  { name: 'STATUS_TEXT', floor: 4.5, what: 'semantic TEXT' },
  { name: 'STATUS_ICON', floor: 3, what: 'a semantic ICON' },
  // theme/scheduleScales.js — the two scales that are NOT severity, so they
  // could not go through STATUS_DOT and needed measuring of their own. Same
  // 3:1 non-text floor; both are dots.
  { name: 'JOB_TYPE_DOT', floor: 3, what: 'a job-type DOT (categorical)' },
  { name: 'JOB_STAGE_DOT', floor: 3, what: 'a job-stage DOT (ordinal)' },
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

  /* ── The palette resolution itself ────────────────────────────────────
   *
   * Everything below measures against PALETTE, so a converter that is wrong
   * in a smooth way — a transposed matrix row, a missing gamma step — moves
   * every ratio together and can still clear every floor. The suite would be
   * green and meaningless, which is precisely the state this file was already
   * in for as long as it held v3 hexes.
   *
   * These three check the resolution rather than the colours.
   */

  it('resolves Tailwind\'s palette at all', () => {
    // A regex that stops matching (a theme.css reformat, a package layout
    // change) would empty PALETTE, and then `hexOf` returns null for
    // everything and every assertion below quietly skips.
    expect(Object.keys(PALETTE).length,
      'PALETTE is empty or tiny — did theme.css move or change shape?').toBeGreaterThan(200)
    for (const step of ['emerald-600', 'amber-700', 'rose-600', 'blue-700', 'violet-600']) {
      expect(PALETTE[step], `${step} did not resolve`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('converts oklch correctly at the two ends where the answer is known', () => {
    expect(HEX(oklchToRgb(1, 0, 0)), 'oklch(100% 0 0) is white').toBe('#ffffff')
    expect(HEX(oklchToRgb(0, 0, 0)), 'oklch(0% 0 0) is black').toBe('#000000')
  })

  it('produces a ramp that actually gets darker as the step number rises', () => {
    // The cheap, decisive check on the conversion. Tailwind's ramps are
    // monotonic in lightness by construction, so if 700 comes out lighter
    // than 600 the maths is wrong — and a wrong-but-smooth converter cannot
    // survive this even though it survives every contrast floor.
    const hues = [...new Set(Object.keys(PALETTE).map(k => k.replace(/-\d+$/, '')))]
    const inversions = []
    for (const hue of hues) {
      const steps = Object.keys(PALETTE)
        .filter(k => k.startsWith(`${hue}-`))
        .map(k => Number(k.split('-').pop()))
        .sort((a, b) => a - b)
      for (let i = 1; i < steps.length; i++) {
        const prev = lum(rgb(PALETTE[`${hue}-${steps[i - 1]}`]))
        const curr = lum(rgb(PALETTE[`${hue}-${steps[i]}`]))
        if (curr > prev) inversions.push(`${hue} ${steps[i - 1]} -> ${steps[i]}`)
      }
    }
    expect(hues.length, 'no hues parsed').toBeGreaterThan(15)
    expect(inversions,
      'these ramps get LIGHTER as the step rises, so the oklch conversion is '
      + 'wrong:\n  ' + inversions.join('\n  ')).toEqual([])
  })

  it('resolves every step it measures, so a hue missing from PALETTE is loud', () => {
    // hexOf returns null for a step PALETTE does not list, and the assertions
    // below `continue` past it — so adding `bg-teal-700` to a measured map and
    // forgetting to add teal here measures NOTHING and passes. That is the
    // same fail-open shape the MIGRATED ratchet was mutation-tested for, and
    // it bit on the first hue the schedule scales brought in.
    const unresolved = []
    for (const { name } of MAPS) {
      for (const { key, classes } of mapEntries(name)) {
        if (TOKEN_BASED.test(classes)) continue
        const { light, dark } = split(classes)
        for (const cls of [...light, ...dark]) {
          if (!hexOf(cls)) unresolved.push(`${name}.${key}  ${cls}`)
        }
      }
    }
    expect(unresolved,
      'these steps went unmeasured because PALETTE has no hex for them — add it:\n  '
      + unresolved.join('\n  '),
    ).toEqual([])
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
