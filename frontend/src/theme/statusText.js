/**
 * Status colour for TEXT and for ICONS — two maps, because they sit under two
 * different WCAG floors.
 *
 * `theme/statusDots.js` handled the dots. This is the other half of
 * BB-A11Y-02, and the thing that makes it a separate slice rather than a
 * continuation is that one class can be either:
 *
 *     <span className="text-amber-600">Needs a cleaner</span>   TEXT  → 4.5:1
 *     <AlertTriangle className="w-4 h-4 text-amber-600" />      ICON  → 3:1
 *
 * Same utility, same hue, different floor. Sweeping both to one step would
 * either leave the text short or darken every icon past the point of reading
 * as its colour.
 *
 * ## Measured against this app's own light grounds
 *
 * `#ffffff #f7f7f8 #f0f0f2 #e7e7ea`, taking the worst of the four:
 *
 *     step           ratio   text 4.5:1   icon 3:1
 *     amber-600      2.58    fail         fail
 *     amber-700      4.07    fail         PASS
 *     amber-800      5.75    PASS         PASS
 *     emerald-600    3.05    fail         PASS (barely)
 *     emerald-700    4.44    fail         PASS
 *     emerald-800    6.23    PASS         PASS
 *     rose-600       3.81    fail         PASS
 *     rose-700       5.09    PASS         PASS
 *     blue-600       4.19    fail         PASS
 *     blue-700       5.43    PASS         PASS
 *     violet-600     4.62    PASS         PASS
 *
 * Two things that are easy to assume and wrong. **`amber-600` fails even the
 * ICON floor** at 2.58, so an amber warning icon was below the bar for a
 * graphical object, never mind text. And **the 700 step is not enough for
 * text** on amber (4.07) or emerald (4.44) — both need the 800. A flat "move
 * everything one step" rule would have left those two short while looking
 * like it had fixed them.
 *
 * `violet-600` already passes both and is unchanged.
 *
 * ## Why ICON mirrors the dot steps exactly
 *
 * An icon and a dot are the same kind of thing to WCAG — a non-text graphical
 * object conveying meaning — so they take the same floor and the same steps.
 * `STATUS_ICON` is `STATUS_DOT`'s hues with a `text-` prefix rather than a
 * second opinion about them.
 *
 * ## `red` is not here, deliberately
 *
 * The app's measured bad-news hue is **rose**: `SEV_DOT.urgent`,
 * `STATUS_DOT.problem` and `TAG_TONE.rose` all use it, and `red-*` is not in
 * the contrast harness's palette at all. The dot migration already moved
 * `bg-red-500` onto `STATUS_DOT.problem`; `text-red-600` moves onto
 * `STATUS_TEXT.problem` for the same reason — one measured hue for "wrong",
 * not two that drift.
 *
 * ## Dark mode
 *
 * Unchanged in intent from `TAG_TONE`: the 300 steps sit at 8.17–10.71
 * against the dark grounds and already clear both floors comfortably.
 * Darkening them would make them vanish. Every entry carries both halves, and
 * they must stay literal — Tailwind's JIT only emits classes it can see whole,
 * so `text-${hue}-800` is purged from the build.
 */

/** Semantic TEXT. 4.5:1 floor — a status word, an error line, a money figure. */
export const STATUS_TEXT = {
  /** Done, paid, accepted, in sync. */
  ok: 'text-emerald-800 dark:text-emerald-300',
  /** Waiting on someone, or something still to do. */
  attention: 'text-amber-800 dark:text-amber-300',
  /** Failed, expired, overdue — wrong now. */
  problem: 'text-rose-700 dark:text-rose-300',
  /** True, but neither good nor bad. */
  info: 'text-blue-700 dark:text-blue-300',
  /** Open to crew / recurring. Already cleared the floor at 600. */
  open: 'text-violet-600 dark:text-violet-300',
  /** Quiet, inactive, not applicable — the theme's own measured ink ramp. */
  neutral: 'text-ink-3',
}

/**
 * Semantic ICONS. 3:1 non-text floor, so these are `STATUS_DOT`'s steps with a
 * `text-` prefix — an icon and a dot are the same kind of object.
 */
export const STATUS_ICON = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  attention: 'text-amber-700 dark:text-amber-400',
  problem: 'text-rose-600 dark:text-rose-400',
  info: 'text-blue-600 dark:text-blue-400',
  open: 'text-violet-600 dark:text-violet-400',
  neutral: 'text-ink-3',
}
