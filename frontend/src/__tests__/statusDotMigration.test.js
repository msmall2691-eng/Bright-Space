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

/**
 * A SOLID resting background on a failing step.
 *
 * The negative lookbehind exempts `hover:` / `active:` / `dark:` and every
 * other variant prefix. The trailing `(?!/)` exempts an opacity modifier:
 * `bg-blue-500/10` is a 10% wash behind text, not a dot. Its contrast question
 * is about whatever sits ON it, which is a different pair and a different
 * floor, so folding those in would stop this test stating one clear rule.
 * (Whether a resting tint belongs there at all is the design language's
 * bubble veto, which other tests already grep for.)
 */
const RAW_DOT = new RegExp(String.raw`(?<![\w:-])bg-(?:${STATUS_HUES})-(?:400|500)\b(?!/)`, 'g')

/**
 * A resting semantic TEXT colour on a step that misses the 4.5:1 text floor.
 *
 * Measured against this app's own light grounds: amber-600 2.58, emerald-600
 * 3.05, rose-600 3.81, blue-600 4.19 — and the 700 step is still short for
 * amber (4.07) and emerald (4.44), which is why `STATUS_TEXT` puts those two
 * on the 800. `violet-600` clears at 4.62 and is deliberately absent.
 *
 * Narrower than RAW_DOT on purpose: it lists the steps that actually fail
 * rather than a blanket 500/600, because `text-blue-800` and friends are fine
 * and flagging them would make this noise.
 */
const RAW_TEXT = new RegExp(String.raw`(?<![\w:-])text-(?:emerald|green)-(?:500|600|700)\b(?!/)|(?<![\w:-])text-(?:amber|yellow)-(?:500|600|700)\b(?!/)|(?<![\w:-])text-(?:red|rose)-(?:400|500|600)\b(?!/)|(?<![\w:-])text-blue-(?:400|500|600)\b(?!/)`, 'g')

/** Surfaces where the TEXT half has been done. Separate from MIGRATED because
 *  it is a separate slice running behind it, and conflating the two would
 *  claim ground that has not been taken. */
const TEXT_MIGRATED = ['crew', 'schedule', 'client', 'office', 'components']

/**
 * Surfaces migrated so far, newest last. Adding one is a one-line change
 * here plus the migration itself.
 */
const MIGRATED = [
  // MyDay is a page but belongs to the crew surface; the `pages` entry below
  // covers it too, which is harmless — both assert the same thing about it.
  { name: 'crew', dirs: ['components/crew'], files: ['pages/MyDay.jsx'] },
  { name: 'schedule', dirs: ['components/schedule'], files: [] },
  { name: 'client', dirs: ['components/client', 'components/clients'], files: [] },
  { name: 'office', dirs: ['components/settings', 'components/invoicing', 'components/quoting',
                           'components/properties', 'components/comms', 'components/ui'], files: [] },
  { name: 'pages', dirs: ['pages'], files: [] },
  // The remaining top-level components, which is everything under
  // `components/` not already named above — so between this and `pages`, the
  // guard now covers the whole of src/ rather than a growing list of corners.
  { name: 'components', dirs: ['components'], files: [] },
]

/**
 * Files inside a migrated surface that keep a raw step ON PURPOSE. Every one
 * carries its reason, because an unexplained exemption is indistinguishable
 * from a miss, and because these are the decisions most likely to be
 * revisited.
 */
const EXEMPT = {
  // Was 4: the categorical property-type bar accounted for two of them
  // (amber + blue; purple is not a STATUS_HUE). That bar now takes the
  // measured JOB_TYPE_EDGE value off the shared config, so what is left is the
  // iCal-source dot and the ringed needs-a-cleaner halo — both ringed, and the
  // ring changes the effective contrast in a way this harness does not model.
  'components/schedule/VisitCard.jsx': { allow: 2,
    reason: 'the iCal-source dot and a ringed halo dot — the ring changes the effective contrast, which this harness does not model' },
  'components/schedule/MonthDayCell.jsx': { allow: 1,
    reason: 'ringed halo dot — the ring changes the effective contrast, which this harness does not model' },
  'components/schedule/WeekGrid.jsx': { allow: 4,
    reason: 'alpha drag preview, the now-line (position, not good/bad), and ringed halo dots' },
  // bg-emerald-500 with text-white ON it. The contrast that matters is
  // white-on-emerald, which passes; darkening the fill would make it WORSE.
  // The single most important site not to sweep.
  'components/schedule/CompleteVisitModal.jsx': { allow: 1,
    reason: 'a filled control with white text ON it — the pair is white-on-emerald, which passes; darkening the fill would make it worse' },
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

  // --- client surface ---
  // The same shape as the schedule's, which is the point: the maps that resist
  // STATUS_DOT across this app are consistently ORDERED or CATEGORICAL, not
  // severity. Three of this file's six maps migrated; these three did not:
  //   QUOTE_COLORS   seven states with TWO good ends — `accepted` and
  //                  `converted` would both collapse to `ok` and stop being
  //                  distinguishable. Already off-vocabulary (teal; indigo is
  //                  the accent).
  //   OPP_COLORS     a pipeline, new -> qualified -> quoted -> won/lost.
  //                  Ordered, and `purple` is off-vocabulary too.
  //   PROPERTY_TYPE  residential / commercial / str is IDENTITY.
  'components/client/constants.js': { allow: 11,
    reason: 'quote/opportunity pipelines and the categorical property-type map — need a measured ordinal ramp' },
  'components/client/ActivityTimeline.jsx': { allow: 1,
    reason: 'falls back to the opportunity-stage colour, which is part of that deferred ordinal map' },
  'components/client/ClientCalendarTab.jsx': { allow: 2,
    reason: 'falls back to the categorical job-type dot, deferred with the rest of that map' },
  'components/client/ClientListTabs.jsx': { allow: 2,
    reason: 'a local residential/commercial type map — categorical, same decision as PROPERTY_TYPE_COLORS' },

  // --- office surface ---
  // Two button FILLS with white text on them. The pair is white-on-amber,
  // which passes; darkening the fill would make it worse, not better.
  'components/settings/DangerZone.jsx': { allow: 1,
    reason: 'a filled button with white text on it — the contrast pair is white-on-amber, which passes' },
  'components/comms/ComposeBar.jsx': { allow: 1,
    reason: 'a filled send button with white text on it — same pair, passes as is' },
  // Categorical, not severity.
  'components/settings/constants.js': { allow: 3,
    reason: 'TYPE_BADGE maps FIELD TYPES (text/number/date/select/…) — identity, not severity; needs a categorical ramp' },
  'components/quoting/constants.js': { allow: 8,
    reason: 'quote lifecycle with two good ends plus a lead pipeline — same decision as client QUOTE_COLORS, deferred with it' },
  'components/quoting/FollowUpRow.jsx': { allow: 1,
    reason: 'two follow-up REASONS (opened / not opened) — categorical, and purple is off-vocabulary' },

  // --- pages surface ---
  // A filled checkbox: `border-emerald-500 bg-emerald-500 text-white`. The pair
  // that matters is the white check ON the fill, which passes; darkening the
  // fill would reduce it. Same call as CompleteVisitModal.
  'pages/OpsBoard.jsx': { allow: 1,
    reason: 'a filled checkbox with a white check on it — the pair is white-on-emerald, which passes' },

  // --- remaining components ---
  // The opportunity pipeline again (new -> qualified -> quoted -> won/lost,
  // with purple), deferred alongside its twins in client/ and quoting/ so one
  // decision is not split across four files. ClientCRMSummary also carries a
  // StatCard `color` prop map keyed by COLOUR NAME, which is a presentational
  // API rather than a severity.
  'components/ClientCRMSummary.jsx': { allow: 8,
    reason: 'opportunity pipeline plus a colour-name-keyed StatCard prop map — ordinal and presentational, not severity' },
  'components/OpportunityLinker.jsx': { allow: 3,
    reason: 'the same opportunity pipeline, deferred with it' },
  // The user PICKS these: they are sticky-note paper colours, not a status.
  'components/board/StickyNotes.jsx': { allow: 3,
    reason: 'note paper swatches the user chooses — decorative, carrying no state at all' },
  'components/CalendarView.jsx': { allow: 1,
    reason: 'an orange booking-source dot — categorical, and orange is outside the status vocabulary entirely' },
}

/** TEXT-half exemptions, same {reason, allow} contract as EXEMPT above. */
const TEXT_EXEMPT = {
  // Avatar colour pairs for client initials — `bg-rose-600/20 text-rose-400`
  // and friends. The text sits on ITS OWN tinted background, not on the page
  // ground, so the four-grounds measurement these steps are judged against
  // simply does not describe this pair. Measuring it means measuring
  // text-on-tint, which is a different harness and a different question;
  // sweeping it here would change a palette on numbers that do not apply to
  // it. Also categorical (one colour per client), not severity.
  'components/clients/constants.js': { allow: 1,
    reason: 'avatar initials palette — text on its own tint, not on a page ground, and categorical rather than severity' },
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
    for (const name of ['crew', 'schedule', 'client', 'office', 'pages', 'components']) {
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
        const hits = []
        src.split('\n').forEach((line, i) => {
          for (const m of line.matchAll(RAW_DOT)) hits.push(`${rel(path)}:${i + 1}  ${m[0]}`)
        })
        const ex = EXEMPT[rel(path)]
        // An exemption carries an EXACT allowance, not a blanket pass. A file
        // can be partly migrated — client/constants.js keeps three ordinal and
        // categorical maps while its status maps move — and the deferred sites
        // must not become an unguarded hole that new ones can hide in.
        if (!ex) offenders.push(...hits)
        else if (hits.length > ex.allow) {
          offenders.push(
            `${rel(path)} has ${hits.length} raw steps but is only allowed ${ex.allow} ` +
            `(${ex.reason}) — migrate the new one or raise the allowance deliberately`)
        }
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
      //
      // Matches `STATUS_DOT.` specifically, not the bare word: several files
      // name it in a comment explaining why a map was NOT migrated, and that
      // is prose, not a use.
      const missing = filesFor(surface)
        .filter(({ src }) => /STATUS_DOT\./.test(src) && !src.includes('statusDots'))
        .map(({ path }) => rel(path))
      expect(missing, `uses STATUS_DOT without importing it: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('every exemption names a real file, so the list cannot rot quietly', () => {
    // An exemption for a file that was renamed or deleted silently widens the
    // ban's blind spot. Each one must still exist AND still contain the thing
    // it is excused for.
    for (const [path, ex] of Object.entries(EXEMPT)) {
      const src = readFileSync(join(SRC, path), 'utf8')
      const n = [...src.matchAll(RAW_DOT)].length
      expect(ex.reason.length, `${path}: exemption has no reason`).toBeGreaterThan(20)
      expect(n, `${path} is exempt but no longer has a raw step — drop the exemption`)
        .toBeGreaterThan(0)
      // An allowance larger than reality is a hole that opens quietly as the
      // file gets migrated, so it has to track exactly.
      expect(n, `${path}: allowance is ${ex.allow} but only ${n} raw steps remain — lower it`)
        .toBe(ex.allow)
    }
  })

  for (const surface of MIGRATED.filter(s => TEXT_MIGRATED.includes(s.name))) {
    it(`${surface.name}: no hand-written semantic text colour outside the named exemptions`, () => {
      const offenders = []
      for (const { path, src } of filesFor(surface)) {
        const ex = TEXT_EXEMPT[rel(path)]
        const hits = []
        src.split('\n').forEach((line, i) => {
          for (const m of line.matchAll(RAW_TEXT)) hits.push(`${rel(path)}:${i + 1}  ${m[0]}`)
        })
        if (!ex) offenders.push(...hits)
        else if (hits.length > ex.allow) {
          offenders.push(`${rel(path)} has ${hits.length} raw text steps, allowed ${ex.allow} (${ex.reason})`)
        }
      }
      expect(offenders,
        'Resting semantic text on a step under the 4.5:1 floor (amber-600 is ' +
        '2.58:1). Use STATUS_TEXT from src/theme/statusText.js — or STATUS_ICON ' +
        'if it is an icon, which is a graphical object at 3:1, not text:\n  '
        + offenders.join('\n  ')).toEqual([])
    })
  }

  it('every ${STATUS_*} is actually interpolated, not sitting dead in a quoted string', () => {
    // The failure this exists for shipped silently and I only caught it in a
    // merge conflict. A migration pass rewrote
    //     `... ${x ? 'font-semibold text-amber-700' : 'opacity-90'}`
    // into
    //     `... ${x ? 'font-semibold ${STATUS_TEXT.attention}' : 'opacity-90'}`
    // where the inner string is SINGLE-quoted, so `${...}` is literal text.
    // Tailwind emits nothing for a class named `${STATUS_TEXT.attention}`, so
    // the element renders with NO colour — and nothing else notices: it is not
    // a raw step, so the guards above skip it; it is valid JS, so the build
    // passes; and no test asserts on that class.
    const offenders = []
    for (const surface of MIGRATED) {
      for (const { path, src } of filesFor(surface)) {
        src.split('\n').forEach((line, i) => {
          for (const m of line.matchAll(/\$\{STATUS_/g)) {
            let quote = null
            for (let k = m.index - 1; k >= 0; k--) {
              const c = line[k]
              if (c === '`' || c === "'" || c === '"') { quote = c; break }
            }
            if (quote !== '`') {
              offenders.push(`${rel(path)}:${i + 1}  enclosed by ${quote ?? 'nothing'}, not a template`)
            }
          }
        })
      }
    }
    expect(offenders,
      'These render the literal text "${STATUS_...}" as a class name, so the ' +
      'element gets no colour at all:\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('no JSX attribute takes a bare template where it needs braces', () => {
    // The mirror of the inert-interpolation bug, and introduced by the FIX for
    // it: promoting `accent="text-emerald-600"` to a template produced
    //     accent=`${STATUS_TEXT.ok}`
    // which is a parse error, because a JSX attribute value is braces or a
    // plain string, never a bare template. That one was loud — the build
    // failed — but the two bugs are the same mistake from opposite sides, so
    // both are worth pinning rather than relying on the compiler for one and
    // a guard for the other.
    const offenders = []
    for (const surface of MIGRATED) {
      for (const { path, src } of filesFor(surface)) {
        src.split('\n').forEach((line, i) => {
          if (/\w+=`\$\{STATUS_/.test(line)) {
            offenders.push(`${rel(path)}:${i + 1}  attribute takes a bare template; use ={STATUS_...}`)
          }
        })
      }
    }
    expect(offenders, offenders.join('\n  ')).toEqual([])
  })

  it('the text pattern catches what was there and spares what already passes', () => {
    const caught = s => [...s.matchAll(RAW_TEXT)].map(m => m[0])
    expect(caught('<span className="text-amber-600">Needs a cleaner</span>')).toEqual(['text-amber-600'])
    expect(caught('text-emerald-700')).toEqual(['text-emerald-700'])  // 4.44, still short
    expect(caught('text-red-600 text-rose-600')).toEqual(['text-red-600', 'text-rose-600'])
    // Already clear the floor, or are not semantic at all.
    expect(caught('text-violet-600')).toEqual([])        // 4.62
    expect(caught('text-amber-800 text-emerald-800 text-blue-700 text-rose-700')).toEqual([])
    expect(caught('hover:text-amber-600 dark:text-amber-300')).toEqual([])
    expect(caught('text-ink-2 text-link text-slate-900')).toEqual([])
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
