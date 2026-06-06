// Centralized theme control.
//
// The app ships the clean, neutral "Twenty-style" palette by default — white
// surfaces, cool grays, blue accent, tighter type. This is the `mode-clean`
// design-token block in index.css. Dark mode layers `theme-console` on top of
// it (the clean dark variant). The choice persists in localStorage.
//
// NB: the CSS selectors are `body.mode-clean` / `body.mode-clean.theme-console`,
// so the classes must live on <body> (an older dev panel put them on <html>,
// which silently did nothing).

const KEY = 'brightbase_theme'

export function getTheme() {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme) {
  const t = theme || getTheme()
  const body = document.body
  body.classList.add('mode-clean')              // always on — it IS the design
  body.classList.toggle('theme-console', t === 'dark')
  localStorage.setItem(KEY, t)
  return t
}
