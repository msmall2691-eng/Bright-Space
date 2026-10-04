/**
 * Per-cleaner Home header "scene" — the gradient banner behind the greeting and
 * weather on My Day. Pure CSS gradients, no image download (brightbase-economy:
 * the crew app runs on rural cell data, so a header that re-fetches a photo on
 * every open is exactly what we don't want).
 *
 * OWNER-REQUESTED EXCEPTION to the "no gradient cards" line in the design
 * language: that veto governs the quiet OFFICE surface. The crew app is the
 * deliberately fun, customizable one (My Day accent + sticky notes), and the
 * owner asked for a colourful, pick-your-own header here. Scoped to this one
 * banner — it does not spread to the office.
 *
 * Like the accent, the choice is a per-viewer convenience: localStorage only,
 * no backend, no payload. 'auto' follows the cleaner's chosen accent colour so
 * the two personalisations move together by default.
 */
const STORAGE_KEY = 'bb_crew_hero'

export const HERO_SCENES = [
  { id: 'auto',     label: 'My colour' },   // follows the accent (default)
  { id: 'sunrise',  label: 'Sunrise',  from: '#fb923c', via: '#f472b6', to: '#a855f7' },
  { id: 'daylight', label: 'Daylight', from: '#38bdf8', via: '#22d3ee', to: '#2dd4bf' },
  { id: 'dusk',     label: 'Dusk',     from: '#7c3aed', via: '#db2777', to: '#f97316' },
  { id: 'night',    label: 'Night',    from: '#0f172a', via: '#1e3a8a', to: '#312e81' },
  { id: 'ocean',    label: 'Ocean',    from: '#0369a1', via: '#0891b2', to: '#0e7490' },
  { id: 'forest',   label: 'Forest',   from: '#15803d', via: '#0f766e', to: '#166534' },
]

/** The CSS `background-image` for a scene. 'auto' reads the live accent vars so
 *  it recolours with the cleaner's accent pick; the named scenes are fixed. */
export function heroGradient(sceneId) {
  const s = HERO_SCENES.find(x => x.id === sceneId) || HERO_SCENES[0]
  if (!s.from) {
    return 'linear-gradient(135deg, rgb(var(--accent-400)) 0%, rgb(var(--accent-600)) 55%, rgb(var(--accent-800)) 100%)'
  }
  return `linear-gradient(135deg, ${s.from} 0%, ${s.via} 50%, ${s.to} 100%)`
}

/** The small swatch gradient for the picker (same angle, smaller). */
export function heroSwatch(sceneId) {
  return heroGradient(sceneId)
}

export function currentHeroId() {
  try { return localStorage.getItem(STORAGE_KEY) || 'auto' } catch { return 'auto' }
}

/** Save the pick and tell any live HeroBanner to recolour at once. */
export function setHero(id) {
  try {
    if (!id || id === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch { /* private window / blocked storage — the event below still updates the view */ }
  try { window.dispatchEvent(new CustomEvent('bb:hero-change', { detail: id || 'auto' })) } catch { /* no-op */ }
}
