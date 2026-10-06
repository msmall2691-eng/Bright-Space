/**
 * The app-wide status dot.
 *
 * The design language settled the SHAPE of a status long ago — a bare 6px dot
 * plus a sentence-case word, nothing around it. What it never settled was the
 * COLOUR, so the dot was written out by hand at each site as `bg-emerald-500`,
 * `bg-amber-500`, `bg-red-500`. Those steps do not clear their floor.
 *
 * ## Why the 500s fail
 *
 * A dot carries meaning but is not text, so WCAG puts it under the 3:1
 * non-text floor rather than 4.5:1. Measured against this app's four light
 * grounds (`--panel --bg --bg-2 --bg-3`), the 500 steps come in at:
 *
 *     amber-500   1.77      emerald-500  2.09
 *     red-500     2.55      blue-500     2.98      gray-400  1.69
 *
 * Not one of them clears 3:1, and amber — the step that means "this needs
 * you" — is the worst of the set at well under half the floor.
 *
 * That matters most on the crew surface. A cleaner reads these on a phone,
 * outdoors, often in direct sun, which is the exact condition a 1.77:1 ratio
 * fails. `brightbase-design-language` already calls crew a thumb-and-glare
 * surface; this is the colour half of the same point.
 *
 * ## The steps here
 *
 * Each hue moves to the step that actually clears, which is NOT the same
 * ramp position for every hue — equal ramp positions are not equal luminance,
 * so a flat "use the 700" rule leaves some hues short and darkens others past
 * the point of looking like themselves. These are the same measured values
 * `components/board/tokens.js` arrived at for SEV_DOT, so the board and the
 * rest of the app now agree.
 *
 * Dark mode keeps the 400s: against a dark ground they already clear
 * comfortably, and darkening them further would make them disappear. Every
 * entry therefore carries both halves.
 *
 * ## Why this is spelled out and not generated
 *
 * Tailwind's JIT only emits classes it can see as COMPLETE literal strings.
 * `bg-${hue}-700` is purged from the build and the dot renders transparent, so
 * these cannot be composed from a hue plus a step — not here, and not in
 * `components/board/tokens.js`, which keeps its own literals for the same
 * reason. The two files are kept honest by measurement rather than by sharing
 * a variable: `__tests__/boardToneContrast.test.js` reads BOTH and fails if
 * either drops below its floor.
 *
 * ## Vocabulary
 *
 * Named for what the dot MEANS, not what colour it is, so a reader does not
 * have to know that amber means "waiting" — and so a later re-measure can move
 * a step without a rename. Colour meanings follow the design language: amber =
 * needs attention, red = overdue/error, emerald = ok/done, gray = neutral and
 * quiet, blue = informational, violet = open to crew.
 */

export const STATUS_DOT = {
  /** Done, accepted, paid, on file, synced — the quiet good state. */
  ok: 'bg-emerald-700 dark:bg-emerald-400',
  /** Waiting on someone, or something the person still has to do. */
  attention: 'bg-amber-700 dark:bg-amber-400',
  /** Expired, failed, overdue — something is wrong now. */
  problem: 'bg-rose-600 dark:bg-rose-400',
  /** Informational, available, present — true but not good or bad. */
  info: 'bg-blue-600 dark:bg-blue-400',
  /** Open to crew / recurring. */
  open: 'bg-violet-600 dark:bg-violet-400',
  /**
   * Off, inactive, not applicable. Token-based rather than a palette step: it
   * follows the theme's own ink ramp, which is already measured, instead of
   * pinning a gray that would need re-measuring per theme. `gray-400` — what
   * this replaces — was the worst value in the whole set at 1.69:1.
   */
  neutral: 'bg-ink-3',
}

/**
 * The dot's geometry, so the 6px size and the shrink-0 are stated once.
 *
 * `shrink-0` is load-bearing, not cosmetic: inside a flex row with a long
 * label these dots get squashed into ellipses without it, which is most
 * visible on a narrow phone — the crew case again.
 */
export const DOT_SHAPE = 'w-1.5 h-1.5 rounded-full shrink-0'
