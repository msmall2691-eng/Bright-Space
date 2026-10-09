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

// Row tags ("Turnover", "Needs cleaner", …) — text color only. The tinted
// pill backgrounds are gone: tags render as a dot + word (see OpsBoard's
// Tag), per the owner's explicit veto of the bubble labels.
// BB-A11Y-02. The light steps moved DOWN the ramp because the 600s were
// under the 4.5:1 text floor against this page's own grounds — measured as the
// worst of panel / bg / bg-2 / bg-3, not just panel:
//
//   amber-600 2.59  emerald-600 2.96  rose-600 3.67  blue-600 4.25  (violet 4.78)
//
// Only violet passed. Amber and emerald need the 800 step; 700 still fails
// both (4.08 / 4.35). The dark partners were already fine (300s, 8.06-10.68)
// and are left alone — this is a light-theme fix.
//
// The steps differ per hue on purpose. Equal ramp positions are not equal
// luminance, so a uniform "use 700" rule would leave amber and emerald short;
// money-ink in the design system was darkened off its ramp position for the
// same reason. Held by __tests__/boardToneContrast.test.js.
export const TAG_TONE = {
  rose: 'text-rose-700 dark:text-rose-300',
  amber: 'text-amber-800 dark:text-amber-300',
  emerald: 'text-emerald-800 dark:text-emerald-300',
  blue: 'text-blue-700 dark:text-blue-300',
  indigo: 'text-link',
  violet: 'text-violet-700 dark:text-violet-300',
  gray: 'text-ink-3',
}

// Severity → the little leading dot + the filter-chip accent.
//
// A dot is non-text, so the floor is 3:1 rather than 4.5:1. In light:
// amber-500 1.73, emerald-500 2.00, rose-500 3.04, blue-500 3.05. The first
// two miss it outright; the other two clear it by a hundredth, which is not a
// margin to put a dot on. These had no dark variant at all, so the same value
// had to serve both themes; now each theme gets the step that clears it.
// (Numbers restated when boardToneContrast stopped measuring a hardcoded
// Tailwind v3 palette and started reading the v4 one the build ships — rose
// and blue read 2.98 under v3, so the old "missed even that" was wrong for
// them. The steps are unchanged; 3.04 was never the plan.)
export const SEV_DOT = {
  urgent: 'bg-rose-600 dark:bg-rose-400',
  watch: 'bg-amber-700 dark:bg-amber-400',
  info: 'bg-blue-600 dark:bg-blue-400',
  good: 'bg-emerald-700 dark:bg-emerald-400',
  recurring: 'bg-violet-600 dark:bg-violet-400',
}

// The focus bar's single dot — amber when something needs attention, emerald
// on a quiet morning. It lives here rather than in FocusBar.jsx so it is one
// of the maps __tests__/boardToneContrast.test.js measures: on the amber 500
// step it was 1.77:1 against this page's own grounds, which made the LARGEST status
// signal on the landing screen the worst-contrast one. Same steps as SEV_DOT.
export const FOCUS_DOT = {
  attention: 'bg-amber-700 dark:bg-amber-400',
  calm: 'bg-emerald-700 dark:bg-emerald-400',
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
  red: 'text-rose-700 dark:text-rose-400',
  amber: 'text-amber-800 dark:text-amber-400',
  emerald: 'text-emerald-800 dark:text-emerald-400',
  money: 'text-emerald-800 dark:text-emerald-400',
  neutral: 'text-ink',
}

// Integration status dot. Same 3:1 non-text floor as SEV_DOT.
export const INT_DOT = {
  green: 'bg-emerald-700 dark:bg-emerald-400',
  amber: 'bg-amber-700 dark:bg-amber-400',
  red: 'bg-rose-600 dark:bg-rose-400',
  gray: 'bg-ink-3',
}

export const SEV_ORDER = ['all', 'urgent', 'watch', 'info', 'good', 'recurring']
