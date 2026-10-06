/**
 * How far BB-A11Y-02 has got, and what each migrated surface still exempts.
 *
 * `boardToneContrast.test.js` proves `STATUS_DOT`'s steps clear the 3:1
 * non-text floor. It cannot prove anyone USES them — a single `bg-amber-500`
 * written straight into a span is invisible to it, and that is how ~900 of
 * these accumulated. This is the other half: the measured map is correct, and
 * the surfaces below go through it.
 *
 * ## Why one registry instead of a test per surface
 *
 * The migration runs surface by surface, so the interesting fact is not "crew
 * is clean" but WHERE THE LINE CURRENTLY IS. A reader opening this file sees
 * the migrated set, the un-migrated remainder, and — the part that rots
 * fastest — every file deliberately left behind WITH its reason. A per-surface
 * copy of this test would scatter those reasons and let them drift.
 *
 * ## The floor
 *
 * A status dot carries meaning but is not text, so WCAG puts it under 3:1
 * rather than 4.5:1. Measured against this app's four light grounds, the steps
 * being banned here are: amber-500 1.77, emerald-500 2.09, red-500 2.55,
 * blue-500 2.98, gray-400 1.69. Not one clears it.
 *
 * ## What this never flags, on any surface
 *
 * - **A variant prefix.** `hover:` / `active:` / `focus:` are transient
 *   feedback the design language explicitly allows ("don't flatten hover
 *   states while chasing this rule"); only a RESTING fill is the vetoed thing.
 *   `dark:` sits on a dark ground where the 400s already clear.
 * - **`text-*` colours.** Different floor (4.5:1) and genuinely different
 *   judgement per site — a link blue, a money green and a decorative icon
 *   amber are three different questions. Their own slice.
 * - **`bg-indigo-*`.** Remapped onto `--accent-*` (BB-A11Y-03), so it is the
 *   accent rather than a status colour; `accentLinkContrast` owns it.
 * - **`bg-ink-3`, `bg-ink-3/40`, `bg-white`.** Token-based, or a deliberate
 *   on-selected inverse. How loud "inactive" should be is a design decision
 *   about quietness, not a contrast fix.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Hues that carry status meaning. `indigo` is the accent; see the header. */
const STATUS_HUES = 'emerald|amber|red|rose|blue|green|yellow|orange|gray|slate|zinc'

/** A RESTING background on a failing step. The negative lookbehind is what
 *  exempts `hover:` / `active:` / `dark:` and every other variant prefix. */
const RAW_DOT = new RegExp(String.raw`(?<![\w:-])bg-(?:${STATUS_HUES})-(?:400|500)\b`, 'g')

/**
 * Surfaces migrated so far, newest last. Adding one is a one-line change
 * here plus the migration itself.
 */
const MIGRATED = [
  { name: 'crew', dirs: ['components/crew'], files: ['pages/MyDay.jsx'] },
  { name: 'schedule', dirs: ['components/schedule'], files: [] },
]

/**
 * Files inside a migrated surface that keep a raw step ON PURPOSE. Every one
 * carries its reason, because an unexplained exemption is indistinguishable
 * from a miss, and because these are the decisions most likely to be
 * revisited.
 */
const EXEMPT = {
  // The colour encodes WHICH TYPE of property, not whether something is good
  // or bad — STR / commercial / residential. Mapping identity onto
  // ok/attention/problem would be wrong, and the dataviz rule is explicit:
  // status tokens only when the colour means good/bad, categorical when it is
  // identity, never both. Needs its own measured categorical ramp.
  'components/schedule/VisitCard.jsx':
    'categorical property-type bar + a ringed halo dot',
  'components/schedule/MonthDayCell.jsx':
    'ringed halo dot — the ring changes the effective contrast, which this harness does not model',
  'components/schedule/WeekGrid.jsx':
    'alpha drag preview, the now-line (position, not good/bad), and ringed halo dots',
  // bg-emerald-500 with text-white ON it. The contrast that matters is
  // white-on-emerald, which passes; darkening the fill would make it WORSE.
  // The single most important site not to sweep.
  'components/schedule/CompleteVisitModal.jsx':
    'a filled control with white text on it — different contrast pair entirely',
  // components/schedule/constants.js was the last entry here and is MIGRATED
  // (Oct 2026). Its two maps were never a severity palette and so could not go
  // through STATUS_DOT — job type is identity, the lifecycle is a nine-state
  // sequence where `dispatched` and `completed` both landed on `ok`. They got
  // measured scales of their own in `theme/scheduleScales.js`: JOB_TYPE_DOT
  // (categorical, CVD-validated), JOB_STAGE_DOT (ordinal) and JOB_TYPE_EDGE,
  // whose inline-style values are per-theme CSS vars because no single literal
  // clears the floor in both. `boardToneContrast` measures the first two;
  // `jobTypeEdgeContrast` measures the vars and holds them in step with the
  // dots. Don't re-add an exemption here without re-reading those.
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * Walk + read each surface ONCE, not once per assertion.
 *
 * Written the obvious way this re-walked two directory trees and re-read every
 * file inside each `it`. Vitest runs test files in a worker pool, so that
 * wasted synchronous IO is not free to the rest of the suite — it is CPU and
 * disk other workers are waiting on, and a neighbouring file whose `waitFor`
 * has the default 1s budget is exactly what gets pushed over the edge. One
 * pass, cached.
 */
const CACHE = new Map()
function filesFor(surface) {
  if (!CACHE.has(surface.name)) {
    const out = []
    for (const d of surface.dirs) out.push(...walk(join(SRC, d)))
    for (const f of surface.files) out.push(join(SRC, f))
    CACHE.set(surface.name, out.map(path => ({ path, src: readFileSync(path, 'utf8') })))
  }
  return CACHE.get(surface.name)
}

const rel = f => relative(SRC, f).split('\\').join('/')

describe('BB-A11Y-02 — migrated surfaces go through the measured map', () => {
  it('does not lose ground — a migrated surface cannot quietly leave the list', () => {
    // Found by mutation-testing this file: deleting a surface from MIGRATED
    // made the suite go 7 tests to 5 and stay GREEN, silently dropping that
    // surface's coverage. A ratchet that fails open is not a ratchet. Naming
    // the achieved set here means removing one takes a deliberate edit in two
    // places, and the list doubles as the record of how far this has got.
    const done = MIGRATED.map(s => s.name)
    for (const name of ['crew', 'schedule']) {
      expect(done, `surface "${name}" was migrated and must stay covered`).toContain(name)
    }
  })

  it('reads the migrated surfaces at all', () => {
    // Non-vacuity. A walk that quietly returned nothing would make every
    // assertion below pass forever — the failure mode of every source scan.
    for (const s of MIGRATED) {
      const fs = filesFor(s)
      expect(fs.length, `${s.name}: walked no files`).toBeGreaterThan(5)
      expect(fs[0].src.length).toBeGreaterThan(0)
    }
  })

  for (const surface of MIGRATED) {
    it(`${surface.name}: no hand-written status dot outside the named exemptions`, () => {
      const offenders = []
      for (const { path, src } of filesFor(surface)) {
        if (EXEMPT[rel(path)]) continue
        src.split('\n').forEach((line, i) => {
          for (const m of line.matchAll(RAW_DOT)) offenders.push(`${rel(path)}:${i + 1}  ${m[0]}`)
        })
      }
      expect(offenders,
        'Resting status fills on a step that misses the 3:1 non-text floor ' +
        '(amber-500 is 1.77:1). Use STATUS_DOT from src/theme/statusDots.js, or ' +
        'add the file to EXEMPT above WITH its reason:\n  ' + offenders.join('\n  '),
      ).toEqual([])
    })

    it(`${surface.name}: imports the map wherever it names it`, () => {
      // A file can reference STATUS_DOT and never import it, which renders
      // `undefined` into the class string — a dot with NO colour, which a
      // contrast test passes happily. This caught six real files on the
      // schedule surface.
      const missing = filesFor(surface)
        .filter(({ src }) => src.includes('STATUS_DOT') && !src.includes('statusDots'))
        .map(({ path }) => rel(path))
      expect(missing, `uses STATUS_DOT without importing it: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('every exemption names a real file, so the list cannot rot quietly', () => {
    // An exemption for a file that was renamed or deleted silently widens the
    // ban's blind spot. Each one must still exist AND still contain the thing
    // it is excused for.
    for (const [path, reason] of Object.entries(EXEMPT)) {
      const src = readFileSync(join(SRC, path), 'utf8')
      expect(reason.length, `${path}: exemption has no reason`).toBeGreaterThan(20)
      expect([...src.matchAll(RAW_DOT)].length,
        `${path} is exempt but no longer has a raw step — drop the exemption`,
      ).toBeGreaterThan(0)
    }
  })

  it('the pattern it bans is the pattern that was there, and it spares hover', () => {
    const caught = s => [...s.matchAll(RAW_DOT)].map(m => m[0])
    expect(caught('<span className="w-1.5 h-1.5 rounded-full bg-amber-500" />')).toEqual(['bg-amber-500'])
    expect(caught("dot: 'bg-emerald-500'")).toEqual(['bg-emerald-500'])
    expect(caught("on ? 'bg-emerald-500' : 'bg-gray-400'")).toEqual(['bg-emerald-500', 'bg-gray-400'])
    // Allowed, and must stay allowed.
    expect(caught('hover:bg-amber-500 active:bg-red-500')).toEqual([])
    expect(caught('dark:bg-emerald-400')).toEqual([])
    expect(caught('group-hover:bg-blue-500')).toEqual([])
    expect(caught('bg-indigo-500 bg-white bg-ink-3/40 bg-emerald-700')).toEqual([])
  })
})
