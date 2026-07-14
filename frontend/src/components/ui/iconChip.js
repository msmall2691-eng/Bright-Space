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
  blue: 'bg-blue-50 text-blue-600',
  violet: 'bg-violet-50 text-violet-600',
  purple: 'bg-purple-50 text-purple-600',
  amber: 'bg-amber-50 text-amber-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  rose: 'bg-rose-50 text-rose-600',
  cyan: 'bg-cyan-50 text-cyan-600',
  slate: 'bg-bg-2 text-ink-2',
}

export function iconChipClass(color) {
  return ICON_CHIP[color] || ICON_CHIP.blue
}
