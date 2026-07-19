// Centralized theme control.
//
// The app ships the clean, neutral "Twenty-style" palette by default — white
// surfaces, cool grays, blue accent, tighter type. This is the `mode-clean`
// design-token block in index.css. Dark mode layers `theme-console` on top of
// it (the clean dark variant). A third option, `neon` (`body.theme-neon`), is
// an independent dark/glass/electric-violet skin — not a `mode-clean` variant,
// so it's mutually exclusive with light/dark rather than layered on top. The
// choice persists in localStorage.
//
// NB: the CSS selectors are `body.mode-clean` / `body.mode-clean.theme-console`
// / `body.theme-neon`, so the classes must live on <body> (an older dev panel
// put them on <html>, which silently did nothing).

const KEY = 'brightbase_theme'
const VALID = ['light', 'dark', 'neon']

// Accent color — recolors the whole app's `indigo-*` scale (remapped to CSS
// vars in index.css / tailwind.config) via a body.accent-* class. Default is
// Indigo (no class needed, but we set it explicitly for clarity).
const ACCENT_KEY = 'brightbase_accent'
export const ACCENTS = ['indigo', 'violet', 'blue', 'emerald', 'rose', 'amber', 'cyan']

export function getAccent() {
  const saved = localStorage.getItem(ACCENT_KEY)
  return ACCENTS.includes(saved) ? saved : 'indigo'
}

export function applyAccent(accent) {
  const a = ACCENTS.includes(accent) ? accent : getAccent()
  const body = document.body
  ACCENTS.forEach(x => body.classList.remove(`accent-${x}`))
  body.classList.add(`accent-${a}`)
  localStorage.setItem(ACCENT_KEY, a)
  return a
}

export function getTheme() {
  const saved = localStorage.getItem(KEY)
  return VALID.includes(saved) ? saved : 'light'
}

export function applyTheme(theme) {
  const t = VALID.includes(theme) ? theme : getTheme()
  const body = document.body
  body.classList.remove('mode-clean', 'theme-console', 'theme-neon')
  if (t === 'neon') {
    body.classList.add('theme-neon')
  } else {
    body.classList.add('mode-clean')             // always on for light/dark — it IS the design
    body.classList.toggle('theme-console', t === 'dark')
  }
  localStorage.setItem(KEY, t)
  return t
}
