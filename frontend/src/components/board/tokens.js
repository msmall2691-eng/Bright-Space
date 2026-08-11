/**
 * Ops Board tone → class maps.
 *
 * Tailwind's JIT only emits classes it can see as COMPLETE literal strings, so
 * every tone is spelled out here rather than interpolated (`bg-${tone}-500/10`
 * would get purged from the build). Colored tones use the standard palette
 * (alpha modifiers work); neutral tones use the app's semantic tokens
 * (bg/panel/ink/hairline) so the board re-skins with the active theme — and
 * nails the dark iOS look under `theme-console`.
 */

// Tag pills (TURNO, OVERDUE, RECURRING, …).
export const TAG_TONE = {
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-300',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
  indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  gray: 'bg-bg-2 text-ink-3',
}

// Severity → the little leading dot + the filter-chip accent.
export const SEV_DOT = {
  urgent: 'bg-rose-500',
  watch: 'bg-amber-500',
  info: 'bg-blue-500',
  good: 'bg-emerald-500',
  recurring: 'bg-violet-500',
}

export const SEV_LABEL = {
  all: 'All',
  urgent: 'Urgent',
  watch: 'Watch',
  info: 'Info',
  good: 'Good',
  recurring: 'Recurring',
}

// Stat-tile hero number color (backend sends the tone).
export const STAT_TONE = {
  red: 'text-rose-600 dark:text-rose-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  money: 'text-emerald-600 dark:text-emerald-400',
  neutral: 'text-ink',
}

// Integration status dot.
export const INT_DOT = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  gray: 'bg-ink-3',
}

export const SEV_ORDER = ['all', 'urgent', 'watch', 'info', 'good', 'recurring']
