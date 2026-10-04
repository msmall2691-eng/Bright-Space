/**
 * Per-cleaner accent colour — the "make it yours" personalisation for the crew
 * app. The whole UI's primary colour is driven by the `--accent-50..950` RGB
 * triples on :root (index.css maps Tailwind's indigo-* onto them), plus
 * `--accent` / `--accent-ink` for the solid fill. Picking an accent overrides
 * those custom properties inline on <html>, which wins over the stylesheet, so
 * buttons, links and active states all recolour at once.
 *
 * The choice is a per-viewer convenience, so it lives in localStorage (their
 * phone, their colour) — no backend, no payload. Reads/writes are wrapped
 * because a private window or blocked storage can throw, and the default
 * ('default') simply removes the overrides so the app's own indigo shows.
 */

const STORAGE_KEY = 'bb_crew_accent'

// Tailwind-ish lightness ramp for stops 50 → 950, with chroma eased off at the
// pale and the very dark ends so a ramp reads as one colour, not neon.
const STOPS = [
  ['50', 0.971, 0.82], ['100', 0.936, 0.85], ['200', 0.866, 0.9], ['300', 0.777, 0.95],
  ['400', 0.666, 1], ['500', 0.58, 1], ['600', 0.506, 1], ['700', 0.43, 0.97],
  ['800', 0.36, 0.92], ['900', 0.3, 0.88], ['950', 0.2, 0.82],
]

/** The presets the picker offers. `default` clears the override (app indigo).
 *  A wheel of hues so there's a real choice — ids are stable, so a saved pick
 *  keeps working as the list grows. */
export const ACCENTS = [
  { id: 'default', label: 'Default' },
  { id: 'blue',    label: 'Blue',    h: 224, s: 0.72 },
  { id: 'sky',     label: 'Sky',     h: 205, s: 0.72 },
  { id: 'cyan',    label: 'Cyan',    h: 190, s: 0.68 },
  { id: 'teal',    label: 'Teal',    h: 176, s: 0.60 },
  { id: 'green',   label: 'Green',   h: 150, s: 0.55 },
  { id: 'lime',    label: 'Lime',    h: 96,  s: 0.60 },
  { id: 'amber',   label: 'Amber',   h: 38,  s: 0.78 },
  { id: 'orange',  label: 'Orange',  h: 24,  s: 0.82 },
  { id: 'red',     label: 'Red',     h: 6,   s: 0.72 },
  { id: 'rose',    label: 'Rose',    h: 345, s: 0.64 },
  { id: 'fuchsia', label: 'Fuchsia', h: 312, s: 0.62 },
  { id: 'violet',  label: 'Violet',  h: 273, s: 0.62 },
  { id: 'indigo',  label: 'Indigo',  h: 248, s: 0.60 },
  { id: 'slate',   label: 'Slate',   h: 220, s: 0.18 },
]

/** HSL (h in degrees, s & l in 0..1) → "R G B" with 0-255 integer channels. */
function hslTriple(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r1, g1, b1].map(v => Math.round((v + m) * 255)).join(' ')
}

/** Relative luminance (0..1) of an "R G B" triple, for picking ink colour. */
function luminance(triple) {
  const [r, g, b] = triple.split(' ').map(Number).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The CSS custom properties for one preset's ramp, keyed by var name. */
export function rampVars(accent) {
  const vars = {}
  for (const [stop, l, satScale] of STOPS) {
    vars[`--accent-${stop}`] = hslTriple(accent.h, accent.s * satScale, l)
  }
  const fill = vars['--accent-600']
  vars['--accent'] = `rgb(${fill})`
  vars['--accent-ink'] = luminance(fill) > 0.55 ? '#0b0b0d' : '#ffffff'
  return vars
}

const VAR_NAMES = [
  ...STOPS.map(([stop]) => `--accent-${stop}`), '--accent', '--accent-ink',
]

/** Apply a preset to <html> (and remember it). 'default' clears the override. */
export function applyAccent(id) {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const accent = ACCENTS.find(a => a.id === id)
  try {
    if (!root) return
    if (!accent || accent.id === 'default' || accent.h == null) {
      VAR_NAMES.forEach(v => root.style.removeProperty(v))
    } else {
      const vars = rampVars(accent)
      Object.entries(vars).forEach(([v, val]) => root.style.setProperty(v, val))
    }
  } catch { /* styling is best-effort */ }
  try {
    if (!accent || accent.id === 'default') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, accent.id)
  } catch { /* private window / blocked storage — the in-session apply still took */ }
}

/** The saved preset id, or 'default' when none/blocked. */
export function currentAccentId() {
  try { return localStorage.getItem(STORAGE_KEY) || 'default' } catch { return 'default' }
}

/** Apply the saved accent on load. Safe to call when nothing is saved (no-op). */
export function initAccent() {
  const id = currentAccentId()
  if (id && id !== 'default') applyAccent(id)
}
