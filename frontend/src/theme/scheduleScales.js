/**
 * The schedule's two colour scales.
 *
 * `theme/statusDots.js` holds the app-wide SEVERITY palette — six tokens named
 * for good/bad (`ok`, `attention`, `problem`, …). The schedule needs two scales
 * that are not severity at all, which is why these could not simply be migrated
 * onto it and sat in `statusDotMigration`'s EXEMPT list instead:
 *
 *   JOB_TYPE_DOT   — STR / residential / commercial. IDENTITY. Mapping it onto
 *                    ok/attention/problem would say a commercial job is worse
 *                    than a residential one. The `dataviz` rule is explicit:
 *                    status tokens only when the colour means good-or-bad,
 *                    a categorical scale when it means which-one.
 *
 *   JOB_STAGE_DOT  — needs_setup → scheduled → dispatched → en_route →
 *                    in_progress → completed, plus no_show / cancelled. A nine
 *                    state SEQUENCE. Collapsed onto six severity tokens,
 *                    `dispatched` and `completed` both landed on `ok` and
 *                    rendered identically — a dispatched job looked finished,
 *                    which is a worse bug than the contrast one that started
 *                    this.
 *
 * ## The floor
 *
 * A dot carries meaning but is not text, so WCAG puts it under the 3:1
 * non-text floor. Measured as the worst of this app's four grounds (`--panel
 * --bg --bg-2 --bg-3`) in each theme, not panel alone. The steps these replace
 * all missed it: amber-500 1.77, blue-500 2.98, red-500 2.55, green-500 2.09,
 * purple-500 2.74. Held by `__tests__/boardToneContrast.test.js`, which reads
 * this file.
 *
 * ## Why every value is spelled out
 *
 * Tailwind's JIT only emits classes it can see as COMPLETE literal strings.
 * `bg-${hue}-700` is purged from the build and the dot renders transparent —
 * so these cannot be composed from a hue plus a step, exactly as
 * `theme/statusDots.js` and `components/board/tokens.js` both document. The
 * three files are kept honest by measurement, not by sharing a variable.
 *
 * ## How the hues were chosen (Meg, Oct 2026)
 *
 * The owner picked the READING; the steps were then measured to it. She chose
 * "warms up as it goes" for the lifecycle — quiet and cool while a job is
 * merely booked, warm while it is actually being worked, green when it is
 * done, so only the live jobs catch the eye — and chose to keep the job-type
 * hues she already knows (amber STR / blue residential / purple commercial).
 */

/**
 * Job type — a CATEGORICAL scale. Identity, never good-or-bad.
 *
 * Validated with the `dataviz` palette validator, all checks pass in light:
 * lightness band, chroma floor, CVD separation (worst pair residential ↔
 * commercial, ΔE 12.3 deuteranopia / 18.1 normal) and contrast.
 *
 * Commercial sits on the 800 rather than the 600 for a reason worth keeping:
 * at purple-600 the deuteranopic ΔE against residential blue was **1.3** —
 * the two most common job types were the same colour for a red-green
 * colourblind reader, and the month grid encodes type by dot alone. Purple and
 * blue cannot be separated by HUE for that reader, so they are separated by
 * LIGHTNESS instead, which is what moving down the ramp buys.
 */
export const JOB_TYPE_DOT = {
  /** Short-term rental / turnover. */
  str: 'bg-amber-700 dark:bg-amber-400',
  residential: 'bg-blue-600 dark:bg-blue-400',
  commercial: 'bg-purple-800 dark:bg-purple-300',
}

/**
 * Job type as an EDGE — the 3px rule on a week block, the dispatch timeline
 * block and the drag ghost.
 *
 * These are inline `style` values on absolutely-positioned elements, which
 * cannot take a Tailwind class, so they have to be real colour values. They
 * are `var()`s rather than literal hexes because a literal cannot serve both
 * themes: a single fixed value has to clear 3:1 against near-white grounds AND
 * against Console's near-black ones, and of the whole Tailwind palette only
 * amber-700, rose-600 and slate-500 manage it — there is no distinct
 * categorical trio in that window. `--accent-link` solves the identical
 * problem the identical way (BB-A11Y-03): one name, the right step per theme,
 * picked in `index.css`.
 *
 * The values track JOB_TYPE_DOT above step for step, so the edge and the dot
 * on the same block are the same colour. `__tests__/jobTypeEdgeContrast.test.js`
 * measures the vars against each theme's own grounds AND asserts they stay in
 * step with these classes — the drift this file exists to prevent.
 */
export const JOB_TYPE_EDGE = {
  str: 'var(--job-edge-str)',
  residential: 'var(--job-edge-residential)',
  commercial: 'var(--job-edge-commercial)',
}

/**
 * Job lifecycle — an ORDINAL scale. "Warms up as it goes."
 *
 *     scheduled    slate    on the books, nothing happening yet
 *     dispatched   blue     crew knows
 *     en_route     sky      on the way — the blue brightens as they get closer
 *     in_progress  amber    happening right now
 *     completed    emerald  done
 *
 * `needs_setup` and the two terminal states sit OUTSIDE that ramp: amber for
 * the one that needs a human, rose for a no-show, and the theme's own ink for
 * the two quiet ones.
 *
 * A true sequential ramp is one hue light→dark, which is not available here:
 * the light end of any ramp is under 3:1 on a white panel, so the usable band
 * is only about four steps deep and four steps of one hue are not tellable
 * apart at 6px. The order is therefore carried by a short cool→warm arc, and —
 * as the design language requires — never by colour alone: every one of these
 * dots ships with its word beside it.
 *
 * Measured pairwise so that no two states render alike. The worst pair in the
 * ramp is `in_progress ↔ no_show` at ΔE 12.8, which is fixed by the design
 * language (amber = needs attention, red = error) and cannot be opened further
 * without changing what those colours mean app-wide.
 *
 * KNOWN, AND DELIBERATE: `needs_setup` and `in_progress` are the same amber,
 * as are `unassigned` and `cancelled`. The owner was shown both overlaps and
 * chose this ramp with them in it. They are safe in a way `dispatched ==
 * completed` was not — neither reads as the other's MEANING, they sit at
 * opposite ends of the lifecycle, and the word is always there. The only step
 * that separates in_progress from needs_setup while clearing the floor is
 * orange-800, a dark brick that stops reading as "live". Don't "fix" this
 * without asking her.
 */
export const JOB_STAGE_DOT = {
  /** No date or no property — nobody can work it as it stands. */
  needs_setup: 'bg-amber-700 dark:bg-amber-400',
  /** On the calendar, crew not picked yet. The ordinary mid-week state of most
   *  of the schedule, so it stays quiet rather than reading as a fault. */
  unassigned: 'bg-ink-3',
  scheduled: 'bg-slate-700 dark:bg-slate-300',
  dispatched: 'bg-blue-800 dark:bg-blue-500',
  en_route: 'bg-sky-600 dark:bg-sky-300',
  in_progress: 'bg-amber-700 dark:bg-amber-400',
  completed: 'bg-emerald-700 dark:bg-emerald-400',
  no_show: 'bg-rose-600 dark:bg-rose-400',
  cancelled: 'bg-ink-3',
}
