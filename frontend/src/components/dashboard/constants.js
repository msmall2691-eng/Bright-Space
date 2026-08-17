/** Flat card surface — Twenty-CRM style. A near-white panel on a hairline
 *  border with only a whisper of shadow, no indigo glow or luminous top
 *  edge. Calm and record-forward: the content is the focus, not the chrome.
 *  (Was the glowing `bb-surface` treatment; flattened for the Twenty look.) */
export const SOFT_CARD =
  'bg-panel rounded-xl border border-hairline shadow-glass-sm'

/** Tinted "tone" backgrounds for actionable rows/callouts that stay legible in
 *  BOTH themes — light -50 fills read as washed-out near-white bars on the dark
 *  canvas, so each carries a translucent dark variant. */
export const TONE = {
  amber:   'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/25',
  blue:    'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/25',
  emerald: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/25',
  purple:  'text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-500/10 border-purple-200 dark:border-purple-500/25',
}
