/**
 * Per-cleaner My Day header "scene" — a SOFT SKY behind the greeting and
 * weather. Pure CSS gradient + a little inline SVG sun/moon/clouds drawn by
 * HeroBanner (no image download — brightbase-economy, rural cell data).
 *
 * The default is the time of day (dawn / day / dusk / night), NOT the accent
 * colour — an amber accent turned the old gradient gold-then-muddy, which the
 * owner didn't like. Accent is still a pickable scene ("My colour") for anyone
 * who wants it.
 *
 * Owner-approved exception to the design language's "no gradient cards" line,
 * which governs the quiet OFFICE surface; this is the friendly crew app. Scoped
 * to this one banner. Saved per-phone in localStorage, no backend.
 */
const STORAGE_KEY = 'bb_crew_hero'

// `sky` = [top, bottom] for a vertical gradient; `dark` = the sky is dark
// enough to want white text. Soft, low-saturation palettes on purpose.
export const HERO_SCENES = [
  { id: 'auto',  label: 'Auto' },
  { id: 'dawn',  label: 'Dawn',  sky: ['#fcd9b0', '#a9c7ec'], dark: false },
  { id: 'day',   label: 'Day',   sky: ['#9fc9f3', '#e8f4ff'], dark: false },
  { id: 'dusk',  label: 'Dusk',  sky: ['#f0a97f', '#5b5a8c'], dark: true },
  { id: 'night', label: 'Night', sky: ['#28406e', '#0b1026'], dark: true },
  { id: 'mine',  label: 'My colour', accent: true, dark: true },
]

/** Which sky the clock points at right now (what 'auto' resolves to). */
export function timeScene() {
  const h = new Date().getHours()
  if (h < 7) return 'night'
  if (h < 11) return 'dawn'
  if (h < 17) return 'day'
  if (h < 20) return 'dusk'
  return 'night'
}

/** The concrete scene to paint for a saved id (resolves 'auto' by the clock). */
export function resolveScene(id) {
  let s = HERO_SCENES.find(x => x.id === (id || 'auto')) || HERO_SCENES[0]
  if (s.id === 'auto') s = HERO_SCENES.find(x => x.id === timeScene()) || HERO_SCENES[2]
  return s
}

/** The CSS background for a resolved scene. 'My colour' reads the live accent. */
export function skyStyle(scene) {
  if (scene.accent) {
    return { backgroundImage: 'linear-gradient(to bottom, rgb(var(--accent-400)) 0%, rgb(var(--accent-700)) 100%)' }
  }
  return { backgroundImage: `linear-gradient(to bottom, ${scene.sky[0]} 0%, ${scene.sky[1]} 100%)` }
}

/** Swatch style for the picker (resolves 'auto' so it shows a real sky). */
export function skySwatch(id) {
  return skyStyle(resolveScene(id))
}

export function currentHeroId() {
  try { return localStorage.getItem(STORAGE_KEY) || 'auto' } catch { return 'auto' }
}

/** Save the pick and tell any live HeroBanner to repaint at once. */
export function setHero(id) {
  try {
    if (!id || id === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch { /* private window / blocked storage — the event below still updates the view */ }
  try { window.dispatchEvent(new CustomEvent('bb:hero-change', { detail: id || 'auto' })) } catch { /* no-op */ }
}
