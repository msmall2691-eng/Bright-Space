/**
 * Shared "colored icon chip" palette — a tinted rounded box behind an icon,
 * used by PageHeader, KpiCard-style stat tiles, and the sidebar logo. Keying
 * on a semantic color name (not a raw Tailwind class) means every call site
 * that wants "amber" gets the exact same tint instead of five near-identical
 * hand-picked ones.
 *
 * Pairs with the `.bb-icon-chip` class in index.css, which adds a soft glow
 * under the Neon theme only (no-op elsewhere) — the futuristic accent shows
 * up for anyone who opts into Neon without changing the light/dark look.
 */
export const ICON_CHIP = {
  blue: 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300',
  violet: 'bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300',
  purple: 'bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300',
  amber: 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300',
  emerald: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  rose: 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300',
  cyan: 'bg-cyan-50 dark:bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
  slate: 'bg-bg-2 text-ink-2',
}

export function iconChipClass(color) {
  return ICON_CHIP[color] || ICON_CHIP.blue
}
