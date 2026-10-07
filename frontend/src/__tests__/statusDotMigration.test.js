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
 * rather than 4.5:1. Measured against this app's four light grounds, worst
 * ground taken, on the palette the build actually ships:
 *
 *     yellow-500 1.55   amber-500  1.73   green-500 1.80   emerald-500 2.00
 *     gray-400   2.11   zinc-400   2.13   slate-400 2.13   orange-500  2.34
 *     rose-500   3.04   blue-500   3.05   red-500   3.09
 *
 * These figures replace an earlier set (amber-500 1.77, emerald-500 2.09,
 * red-500 2.55, blue-500 2.98, gray-400 1.69) read off a hardcoded Tailwind
 * **v3** palette; v4 ships oklch and `boardToneContrast.test.js` now resolves
 * the real thing. One conclusion changed with them, so it is worth stating
 * plainly rather than leaving the old sentence ("Not one clears it") standing:
 * **rose-500, blue-500 and red-500 do clear 3:1** — by 1 to 3 percent.
 *
 * They stay banned anyway, for a reason that is not "they fail". A 3.04
 * against a 3.00 floor is inside the width of the measurement: it is the worst
 * of four grounds chosen by this app's current themes, and a theme adding one
 * slightly darker ground sinks all three without touching a component. #1134
 * had the same call to make on `STATUS_ICON.ok` and kept emerald-700 because
 * "barely" was not a margin worth taking. The other half is the point of the
 * map at all — one measured answer per meaning, rather than each call site
 * re-deciding whether its own dot is the one that may sit at 3.04.
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
// The dead-interpolation guard parses rather than scans; see its own comment
// for why a character scan cannot do this job. TypeScript is the parser the
// repo already has — `npm run gen:types` pulls it in via openapi-typescript —
// and it is declared in devDependencies so this test does not lean on another
// package's transitive dep.
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// Imported, not re-stated: the three guards at the bottom derive what a dark
// half and a hover step should be FROM the maps, so a re-measure that moves a
// step moves them with it.
import { STATUS_DOT } from '../theme/statusDots'
import { STATUS_TEXT, STATUS_ICON } from '../theme/statusText'

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
 * Measured against this app's own light grounds, on the shipped v4 palette:
 * amber-600 2.59, emerald-600 2.96, rose-600 3.67, blue-600 4.25 — and the 700
 * step is still short for amber (4.08) and emerald (4.35), which is why
 * `STATUS_TEXT` puts those two on the 800. `violet-600` clears at 4.78 and is
 * deliberately absent. (The previous figures here — 2.58 / 3.05 / 3.81 / 4.19,
 * 4.07, 4.44, 4.62 — came off the v3 palette; every conclusion survives the
 * correction, which is why nothing below moves.)
 *
 * Narrower than RAW_DOT on purpose: it lists the steps that actually fail
 * rather than a blanket 500/600, because `text-blue-800` and friends are fine
 * and flagging them would make this noise.
 */
const RAW_TEXT = new RegExp(String.raw`(?<![\w:-])text-(?:emerald|green)-(?:500|600|700)\b(?!/)|(?<![\w:-])text-(?:amber|yellow)-(?:500|600|700)\b(?!/)|(?<![\w:-])text-(?:red|rose)-(?:400|500|600)\b(?!/)|(?<![\w:-])text-blue-(?:400|500|600)\b(?!/)`, 'g')

/**
 * Every token map the app interpolates into a className, by name.
 *
 * This is the vocabulary of the dead-interpolation guard below, and it is a
 * LIST OF NAMES rather than a prefix because the bug it catches is indifferent
 * to which family a map belongs to: `'${SEV_DOT.good}'` inside single quotes
 * is as dead as `'${STATUS_TEXT.attention}'`, and the guard used to know only
 * the second. The companion test asserts this equals what those files actually
 * export, so adding a map covers it and renaming one fails loudly.
 *
 * `FIELD_LABELS` and `SEV_LABEL` are copy, not classes — a dead interpolation
 * there renders the literal token name as visible TEXT, which is worse, so
 * they stay in.
 */
const TOKEN_MAPS = [
  'FIELD_LABELS', 'FOCUS_DOT', 'INT_DOT', 'JOB_STAGE_DOT', 'JOB_TYPE_DOT', 'JOB_TYPE_EDGE',
  'PROPERTY_TYPE_CONFIG', 'SEV_DOT', 'SEV_LABEL', 'STAT_TONE', 'STATUS_DOT', 'STATUS_ICON',
  'STATUS_TEXT', 'TAG_TONE', 'VISIT_ACCENT', 'VISIT_STATUS_CONFIG',
]

/**
 * Every way a token map can be written so that it does NOT do what was meant,
 * found in one parsed file. Returns the offenders and how many string literals
 * were inspected, so a caller can tell "clean" from "parsed nothing".
 *
 * ONE implementation, used by both the tree-wide scan and the case test below.
 * They were briefly two copies, which is the arrangement where the cases go on
 * passing while the real check drifts away from them — the same shape of
 * mistake this whole guard exists to catch.
 *
 * ## Shape 1: dead inside a quoted string
 *
 *     `... ${live ? '${SEV_DOT.good}' : 'bg-ink-3'}`
 *
 * The inner string is single-quoted, so `${…}` is literal text and Tailwind
 * emits nothing for a class by that name. Its exact definition in the grammar
 * is "a STRING LITERAL whose text contains `${TOKEN.`", which is why this
 * parses rather than scanning characters: two earlier character-based versions
 * each reported CORRECT code as dead, one tripping over a quoted expression
 * earlier on the line, the other over an apostrophe in JSX text.
 *
 * ## Shape 2: a stray `$` before a JSX expression
 *
 *     <span>${SEV_LABEL.good}</span>            renders "$Good"
 *
 * JSX splits that into a JsxText of `$` and a separate expression, so no
 * string literal contains it and shape 1 cannot see it. It matters most for
 * the maps that are COPY rather than classes — `SEV_LABEL` and `FIELD_LABELS`
 * are in the list for exactly that reason.
 *
 * This is the one that most needs the AST, because "a `$` immediately before a
 * JSX expression" is overwhelmingly CORRECT here: it is how money is written,
 * and `<div>${inv.total?.toFixed(2)}</div>` renders "$240.00". What makes it a
 * bug is the expression REFERENCING A TOKEN MAP, which is a class name or a
 * label and never a price.
 *
 * And that reference is looked for in the expression's own syntax tree rather
 * than in its source text. A prefix match on the text missed every expression
 * that does not START with the map — `${(SEV_LABEL.good)}` behind redundant
 * parentheses, `${FIELD_LABELS[key] ?? key}` behind a fallback — while still
 * rendering the stray dollar. Walking for the identifier has no such corners.
 */
function deadInterpolations(source) {
  const dead = new RegExp(String.raw`\$\{\s*(?:${TOKEN_MAPS.join('|')})\b`)
  const names = new Set(TOKEN_MAPS)
  const offenders = []
  let literalsSeen = 0

  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  /** Does this expression mention a token map anywhere inside it? */
  const mentionsTokenMap = (node) => {
    let hit = false
    const scan = (n) => {
      if (hit) return
      if (ts.isIdentifier(n) && names.has(n.text)) { hit = true; return }
      ts.forEachChild(n, scan)
    }
    scan(node)
    return hit
  }

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literalsSeen++
      if (dead.test(node.text)) {
        offenders.push(`${at(node)}  ${JSON.stringify(node.text).slice(0, 80)}`)
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const kids = node.children
      for (let k = 0; k < kids.length - 1; k++) {
        const text = kids[k]
        const next = kids[k + 1]
        if (ts.isJsxText(text) && text.text.endsWith('$')
            && ts.isJsxExpression(next) && next.expression
            && mentionsTokenMap(next.expression)) {
          offenders.push(`${at(next)}  a stray $ before {${next.expression.getText(source)}}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { offenders, literalsSeen }
}

/** Surfaces where the TEXT half has been done. Separate from MIGRATED because
 *  it is a separate slice running behind it, and conflating the two would
 *  claim ground that has not been taken. */
const TEXT_MIGRATED = ['crew', 'schedule', 'client', 'office', 'components', 'pages']

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

  // --- pages surface ---
  // Text-on-tint again, and worth stating plainly because the mechanical pass
  // got this wrong first time round and half-migrated the map: every colour in
  // these two files arrives with its OWN `bg-*-50` wash attached —
  // `<Pill tone="bg-emerald-50 text-emerald-700">`, `STATUS_TONE`, the round
  // icon tiles. The pair to measure is emerald-700-on-emerald-50, not
  // emerald-700 against `--panel`. Sweeping half of a map like that is worse
  // than leaving it: the entries then disagree about which question they are
  // answering.
  'pages/CustomerPortal.jsx': { allow: 6,
    reason: 'STATUS_TONE and the Pills carry their own bg-*-50 wash — the pair is text-on-tint, which the four-grounds measurement does not describe' },
  'pages/PortalVerify.jsx': { allow: 1,
    reason: 'an AlertCircle in a rounded bg-red-50 tile — the same text-on-tint pair, not icon-on-ground' },
  'pages/Login.jsx': { allow: 1,
    reason: 'an AlertCircle sitting on the error card’s own bg-red-50 — text-on-tint again' },

  // The two customer-facing confirmations. These are LUCIDE ICONS, not text —
  // `<CheckCircle className="w-10 h-10 text-emerald-600 …" />` on `bg-panel` —
  // so the floor is 3:1 for a graphical object rather than 4.5:1, and against
  // `--panel` emerald-600 measures **3.65:1**. RAW_TEXT cannot tell an icon
  // from a word by regex, which is why these read as offenders and are not.
  //
  // One caveat the measurement turned up, recorded because the margin is thin.
  // 3.65 is the ratio against `--panel` (`#ffffff`), which is the ground these
  // two actually sit on. Across all four light grounds emerald-600's WORST is
  // `--bg-3` at **2.96**, which is under the floor — so this exemption is
  // ground-specific and does not license emerald-600 icons generally. Move one
  // of these onto an inset well and it stops being true.
  'pages/PublicQuote.jsx': { allow: 2,
    reason: 'CheckCircle icons on --panel — 3:1 floor, emerald-600 measures 3.65:1 against that specific ground' },
  'pages/PublicJobConfirm.jsx': { allow: 2,
    reason: 'the same two confirmation icons, same --panel ground, same 3.65:1' },

  // The swatch page. Its whole job is to render the palette as literals next
  // to its own name, so the class IS the content — sweeping it would make the
  // page document a set of tokens it no longer shows.
  'pages/DesignSystem.jsx': { allow: 2,
    reason: 'a StatCard accent demo on the design-system swatch page — the literal class is the thing being displayed' },
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

  // Both halves of the ban carry a hand-written exemption list, and both rot
  // the same way, so they are checked by the same code rather than by one test
  // and a good intention. TEXT_EXEMPT was added later; leaving it uncovered
  // would have reopened on the text side the exact hole that was closed on the
  // dot side.
  for (const [label, list, rx] of [['EXEMPT', EXEMPT, RAW_DOT], ['TEXT_EXEMPT', TEXT_EXEMPT, RAW_TEXT]]) {
    it(`every ${label} entry names a real file, so the list cannot rot quietly`, () => {
      // An exemption for a file that was renamed or deleted silently widens the
      // ban's blind spot. Each one must still exist AND still contain the thing
      // it is excused for.
      for (const [path, ex] of Object.entries(list)) {
        const src = readFileSync(join(SRC, path), 'utf8')
        const n = [...src.matchAll(rx)].length
        expect(ex.reason.length, `${path}: exemption has no reason`).toBeGreaterThan(20)
        expect(n, `${path} is exempt but no longer has a raw step — drop the exemption`)
          .toBeGreaterThan(0)
        // An allowance larger than reality is a hole that opens quietly as the
        // file gets migrated, so it has to track exactly.
        expect(n, `${path}: allowance is ${ex.allow} but only ${n} raw steps remain — lower it`)
          .toBe(ex.allow)
      }
    })
  }

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

  it('every ${TOKEN_MAP} is actually interpolated, not sitting dead in a quoted string', () => {
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
    //
    // ## Why this now names every map instead of matching `${STATUS_`
    //
    // It used to match `/\$\{STATUS_/`, which is one family out of a dozen,
    // and the Recurring surface shipped the same bug on a different one:
    //
    //     `h-1.5 w-1.5 rounded-full ${live ? '${SEV_DOT.good}' : 'bg-ink-3'}`
    //
    // on SeriesRow AND SeriesDetail, so the "Active" dot on both the list and
    // the record header rendered with no colour at all. THREE guards read
    // those exact lines and all three passed, for one reason worth keeping in
    // mind when adding another: this bug produces the ABSENCE of a class, and
    // every colour guard looks for a WRONG class. RAW_DOT found no bad step
    // because there was no step; `recurring/__tests__/surfaceGuards.test.js`
    // checks `rounded-full` spans for a 500-ramp hue and found none, again
    // because there was none; and this test only knew `STATUS_`. The build is
    // quiet too — both files import SEV_DOT and use it correctly elsewhere, so
    // the import is live and lint has nothing to say.
    //
    // The fix is to name the maps rather than a prefix. Anything exported as a
    // token map belongs here; the list is asserted non-trivial below so a
    // rename cannot quietly empty it.
    //
    // ## Why this parses instead of scanning characters
    //
    // The first version of this widened check asked "walking back from the
    // `${`, is the nearest quote a backtick?". That is wrong in both
    // directions and the wrong one bit immediately: a CORRECT line with a
    // quoted expression earlier on it,
    //
    //     `h-1.5 rounded-full ${compact ? 'scale-75' : ''} ${SEV_DOT.good}`
    //
    // stops the backward walk at the `'` closing `'scale-75'` and reports a
    // live interpolation as dead. That shape is ordinary — the codebase is
    // full of it — so the guard would have failed CI on correct code and
    // taught the next person to distrust it. Hand-lexing instead of scanning
    // backwards does not rescue it either: a lexer that does not know JSX
    // treats the apostrophe in `<>Couldn't send</>` as opening a string and
    // mis-reads the rest of the line, which it duly did on
    // `settings/IntegrationsTab.jsx`.
    //
    // So this parses. A dead interpolation has an exact definition in the
    // grammar — a STRING LITERAL whose text contains `${TOKEN.` — and the
    // parser settles quotes, comments, regexes, JSX text and nesting for
    // free. `ts.ScriptKind.TSX` reads this codebase's .js/.jsx as well as the
    // generated .ts. A template literal's substitutions are separate nodes
    // and never part of a StringLiteral's text, so a live interpolation
    // cannot be flagged however the line is written; a template with NO
    // substitutions emits its text verbatim, so it is checked too.
    // Deliberately the whole of src/, not MIGRATED. This bug class is purely
    // syntactic — a dead interpolation is never intentional anywhere — so it
    // needs no exemption list and gains nothing from being scoped to the
    // surfaces whose COLOUR choices are being ratcheted. It also reaches
    // hooks/ and utils/, which MIGRATED's dirs do not.
    const offenders = []
    let literalsSeen = 0
    for (const path of walk(SRC)) {
      const source = ts.createSourceFile(
        path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const found = deadInterpolations(source)
      literalsSeen += found.literalsSeen
      for (const f of found.offenders) offenders.push(`${rel(path)}:${f}`)
    }
    // A parse that silently yielded nothing would make this pass on an empty
    // walk, which is the failure mode a ratchet must not have.
    expect(literalsSeen, 'parsed no string literals at all — the walk or the parse broke')
      .toBeGreaterThan(1000)
    expect(offenders,
      'These render the literal text "${TOKEN_MAP...}", or a stray $ before the ' +
      'value, instead of what was meant:\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('tells a dead interpolation from the correct code that looks like one', () => {
    // The inputs that separate this guard from the two it replaced, pinned as
    // cases rather than only described above. Every `good` line is real code
    // someone would write; every `bad` one is a slip that reaches the screen.
    const good = [
      // The character scan reported this as dead: its backward walk stops at
      // the `'` closing `'scale-75'`.
      "const a = <span className={`h-1.5 rounded-full ${compact ? 'scale-75' : ''} ${SEV_DOT.good}`} />",
      // The hand lexer reported this as dead: the apostrophe in JSX text
      // looked to it like the start of a string.
      "const b = <>Couldn't send: <i className={`${STATUS_TEXT.problem} break-words`}>x</i></>",
      // Money. A `$` immediately before a JSX expression is the normal way to
      // write a price, and there are dozens in the tree — so the JSX check
      // below must key on the expression being a TOKEN MAP, not on the `$`.
      'const c = <div>${inv.total?.toFixed(2)}</div>',
      'const d = <span>Total ${parseFloat(q.total || 0).toFixed(2)}</span>',
      // Money behind the same shapes the `bad` list uses below, so the
      // expression walk is pinned as keying on the token map rather than on
      // parentheses or a fallback.
      'const e = <div>${(inv.total ?? 0).toFixed(2)}</div>',
    ]
    const bad = [
      // The SeriesRow bug.
      "const f = <span className={`rounded-full ${live ? '${SEV_DOT.good}' : 'bg-ink-3'}`} />",
      // The form this test was ORIGINALLY written for: the token is not the
      // first thing in the quoted string.
      "const g = `x ${cond ? 'font-semibold ${STATUS_TEXT.attention}' : 'opacity-90'}`",
      // Dead inside a double-quoted JSX attribute.
      'const h = <span className="dot ${STATUS_DOT.ok}" />',
      // Typed straight into JSX text: renders "$Good", not "Good". The
      // character scan caught this one and the string-literal check alone
      // does not, because JSX splits it into a text node and an expression.
      'const i = <span>${SEV_LABEL.good}</span>',
      'const j = <td>${FIELD_LABELS.address}</td>',
      // The same slip where the map is not the first thing in the expression.
      // A prefix match on the expression's SOURCE TEXT passed both of these
      // while React still rendered the stray dollar; walking the expression's
      // syntax tree for the identifier does not care where it sits.
      'const k = <span>${(SEV_LABEL.good)}</span>',
      'const l = <span>${FIELD_LABELS[key] ?? key}</span>',
      'const m = <span>${bad ? SEV_LABEL.urgent : SEV_LABEL.good}</span>',
    ]
    // The REAL check, not a copy of it — see deadInterpolations' comment.
    const flags = (src) => deadInterpolations(
      ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    ).offenders.length > 0
    for (const src of good) expect(flags(src), `false positive on: ${src}`).toBe(false)
    for (const src of bad) expect(flags(src), `missed a dead interpolation in: ${src}`).toBe(true)
  })

  it('the token-map list this scans is the real export list, not a stale copy', () => {
    // The ratchet on the ratchet. The test above is only as wide as
    // TOKEN_MAPS, so a map added to theme/ or board/tokens.js and forgotten
    // here reopens exactly the hole that let the SeriesRow dot through — and
    // it would reopen it SILENTLY, the test still passing on the names it does
    // know. Reading the exports means a new map is covered on the day it
    // lands, and a renamed one fails loudly here instead.
    const exported = []
    for (const path of [...walk(join(SRC, 'theme')),
                        join(SRC, 'components/board/tokens.js'),
                        join(SRC, 'components/schedule/constants.js')]) {
      const src = readFileSync(path, 'utf8')
      for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*=\s*\{/gm)) exported.push(m[1])
    }
    expect(exported.length, 'read no exported maps — the paths above moved').toBeGreaterThan(8)
    expect(TOKEN_MAPS.slice().sort()).toEqual([...new Set(exported)].sort())
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

  /**
   * The three things a half-finished replacement leaves behind.
   *
   * None of these is caught by the bans above — the class that remains is a
   * perfectly legal one, it is just in the wrong relationship with the map now
   * sitting next to it. All three shipped across several merged slices before
   * anyone looked, which is the argument for pinning them rather than trusting
   * the next sweep to be tidier.
   *
   * `STEP_OF` reads the maps rather than restating them, so re-measuring a hue
   * moves these assertions with it.
   */
  const STEP_OF = {}
  for (const [name, map] of [['STATUS_TEXT', STATUS_TEXT], ['STATUS_ICON', STATUS_ICON], ['STATUS_DOT', STATUS_DOT]]) {
    for (const [key, value] of Object.entries(map)) {
      const parts = value.split(' ')
      STEP_OF[`${name}.${key}`] = {
        kind: name === 'STATUS_DOT' ? 'bg' : 'text',
        light: parts.find(p => !p.startsWith('dark:')) || '',
        dark: parts.find(p => p.startsWith('dark:')) || '',
      }
    }
  }
  /** Backtick segments, with the `${STATUS_*.x}` names each one mentions. */
  function segmentsOf(src) {
    const out = []
    src.split('\n').forEach((line, i) => {
      for (const seg of line.match(/`[^`]*`/g) || []) {
        const refs = [...seg.matchAll(/\$\{(STATUS_(?:TEXT|ICON|DOT)\.[a-z]+)\}/g)].map(m => m[1])
        if (refs.length) out.push({ line: i + 1, seg, refs })
      }
    })
    return out
  }

  it('a map that brings its own dark half does not sit next to a second one', () => {
    // Every site read `text-rose-600 dark:text-rose-400`. Replacing the light
    // half alone leaves TWO dark:text-* classes on the element — the map's and
    // the leftover — and which one applies is Tailwind's emission order, not
    // the order in the class attribute. 69 of these shipped.
    //
    // A `dark:bg-*` beside a TEXT map is a background, not a duplicate, and is
    // deliberately allowed: components/comms/primitives.jsx and
    // components/dashboard/constants.js both rely on that pair.
    const offenders = []
    for (const surface of MIGRATED) {
      for (const { path, src } of filesFor(surface)) {
        for (const { line, seg, refs } of segmentsOf(src)) {
          const kinds = new Set(refs.map(r => STEP_OF[r]).filter(s => s && s.dark).map(s => s.kind))
          for (const m of seg.matchAll(/dark:(text|bg)-[a-z]+-\d{3}(?![\w/])/g)) {
            if (kinds.has(m[1])) offenders.push(`${rel(path)}:${line}  ${m[0]} duplicates the map's own dark half`)
          }
        }
      }
    }
    expect(offenders, 'Drop the leftover; the map already carries its dark ' +
      'step:\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('a hover step is a darker step of the resting hue, not a jump or a no-op', () => {
    // Each of these was a coherent one-step-darker ramp before the migration —
    // `text-red-600 hover:text-red-700`. Moving only the resting step left the
    // hover stranded: `rose-700 hover:text-red-700` changes hue mid-interaction,
    // `emerald-800 hover:text-emerald-800` does nothing at all, and
    // `blue-700 hover:text-blue-400` goes LIGHTER, which is a legibility
    // regression exactly when the pointer is on the control.
    const offenders = []
    for (const surface of MIGRATED) {
      for (const { path, src } of filesFor(surface)) {
        for (const { line, seg, refs } of segmentsOf(src)) {
          const wants = new Set(refs.map(r => STEP_OF[r]).filter(Boolean).map(s => {
            const m = /^text-([a-z]+)-(\d{3})$/.exec(s.light)
            return m ? `hover:text-${m[1]}-${Math.min(900, Number(m[2]) + 100)}` : null
          }).filter(Boolean))
          // Two different maps in one segment cannot name one right answer.
          if (wants.size !== 1) continue
          const want = [...wants][0]
          for (const m of seg.matchAll(/hover:text-[a-z]+-\d{3}\b/g)) {
            if (m[0] !== want) offenders.push(`${rel(path)}:${line}  ${m[0]} — want ${want}`)
          }
        }
      }
    }
    expect(offenders, offenders.join('\n  ')).toEqual([])
  })

  it('a template holding one interpolation and nothing else is just the value', () => {
    // `${STATUS_TEXT.ok}` in backticks IS STATUS_TEXT.ok. Harmless, but it is
    // the same shape as the inert-interpolation bug above, so a reader has to
    // stop and check the quoting every time. 67 of them, from the repair pass
    // that fixed that bug.
    const offenders = []
    for (const surface of MIGRATED) {
      for (const { path, src } of filesFor(surface)) {
        src.split('\n').forEach((line, i) => {
          for (const m of line.matchAll(/`(\$\{STATUS_(?:TEXT|ICON|DOT)\.[a-z]+\})`/g)) {
            offenders.push(`${rel(path)}:${i + 1}  ${m[0]} — drop the backticks`)
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
