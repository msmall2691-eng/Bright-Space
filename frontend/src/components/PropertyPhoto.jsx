import { useEffect, useRef, useState } from 'react'

// Read the JWT straight from localStorage rather than importing it from
// ../api. This component is pulled into very widely-rendered surfaces (the
// crew JobCard, the office PropertyDetail), and importing a named api export
// would make every test that partially mocks ../api throw the moment it
// rendered one of those with an address. Same key api.getJWT uses.
function readJWT() {
  try { return localStorage.getItem('brightbase_jwt') } catch { return null }
}

/**
 * One paid Street View call per endpoint, for as long as the tab lives.
 *
 * `lazy` already stops a list fetching photos nobody has scrolled to. What it
 * cannot stop is the SAME photo being fetched twice on one screen, which is
 * what Requests does: the list card (Requests.jsx:364) and the drawer for the
 * row you just opened (:965) are two PropertyPhoto instances on the same
 * address, so opening a request bought a second copy of a photo already on
 * screen. `brightbase-economy` names this case directly — two components
 * fetching one endpoint on one screen — and its rule 4 is that a metered API
 * caches at the row.
 *
 * ## It caches the BLOB, not the object URL
 *
 * This is the part that would be a bug if it were shared. An object URL is
 * owned by whoever revokes it, and every instance revokes on unmount. Hand two
 * cards one URL and closing the drawer blanks the list row behind it. So the
 * cache holds the Blob and each instance makes — and revokes — its own URL
 * from it.
 *
 * ## A 404 is kept, a dead connection is not
 *
 * A rejection with a STATUS means the server answered, and the answer will not
 * change on a retry: 404 is Google having no imagery for that address, 403 is
 * a job that is not this cleaner's. Re-asking buys another metered call for
 * the same no, so those are remembered. A rejection with no status is the
 * network — a tunnel, one bar, a dropped request — which very much will change,
 * so it is dropped and the next mount tries again. Remembering that one would
 * blank a property's photo for the rest of the session over a lost packet,
 * which on rural cell is not a rare event.
 */
const PHOTO_CACHE = new Map()
/** Enough for a long browse, bounded so a phone does not hold every photo it
 *  has ever scrolled past. Oldest out first. */
const PHOTO_CACHE_MAX = 60

/** Test seam: the cache is module state and would otherwise leak between cases. */
export function __resetPhotoCache() { PHOTO_CACHE.clear() }

function photoBlob(endpoint, token) {
  const hit = PHOTO_CACHE.get(endpoint)
  if (hit) {
    PHOTO_CACHE.delete(endpoint)   // re-insert so the cap evicts by recency
    PHOTO_CACHE.set(endpoint, hit)
    return hit
  }
  const pending = fetch(endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
    .catch(err => {
      if (typeof err !== 'number') PHOTO_CACHE.delete(endpoint)
      throw err
    })
  PHOTO_CACHE.set(endpoint, pending)
  // A remembered rejection with no instance mounted to receive it is expected,
  // not an error — claim it so it is not reported as unhandled.
  pending.catch(() => {})
  while (PHOTO_CACHE.size > PHOTO_CACHE_MAX) {
    PHOTO_CACHE.delete(PHOTO_CACHE.keys().next().value)
  }
  return pending
}

/** Front-of-house Street View photo for an address — the SAME photo the
 *  customer sees on their quote, shown to staff on the Requests list/drawer and
 *  the quote composer (keyed on the address, so it works before a quote exists).
 *
 *  The photo endpoint is staff-authenticated (Bearer token), so a plain
 *  <img src> can't load it — we fetch it as a blob with the auth header and
 *  render an object URL. Renders nothing when photos are off, no key is set, or
 *  Google has no imagery (a 404), so a missing photo never leaves a broken tile.
 *
 *  `lazy` defers the fetch until the element scrolls into view — every fetch is
 *  a paid Street View call, so list cards use lazy to only load what's seen.
 *  Two instances on the same endpoint share one call; see PHOTO_CACHE above.
 *
 *  Two ways to point it at a photo:
 *   - `address` → the staff, address-keyed quotes endpoint (office surfaces).
 *   - `url`     → an explicit endpoint, for callers with their own gated route
 *                 (e.g. the crew app's assigned-only /api/crew/jobs/:id/
 *                 property-photo, which the office quotes endpoint 403s for).
 *  `url` wins when both are given. */
export default function PropertyPhoto({ address, url, className = '', lazy = false }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(!lazy)
  const boxRef = useRef(null)
  const objUrl = useRef(null)
  // The endpoint to fetch: an explicit url, else the address-keyed quotes photo.
  // Null when neither is usable (no url and too short an address to match).
  const endpoint = url
    || ((address || '').trim().length >= 5
      ? `/api/quotes/property-photo?address=${encodeURIComponent((address || '').trim())}`
      : null)

  // Lazy: wait until the placeholder is near the viewport before fetching.
  useEffect(() => {
    if (!lazy || visible) return
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect() }
    }, { rootMargin: '250px' })
    io.observe(el)
    return () => io.disconnect()
  }, [lazy, visible])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const clear = () => { if (objUrl.current) { URL.revokeObjectURL(objUrl.current); objUrl.current = null } }
    setSrc(null); setFailed(false); clear()

    if (!endpoint) { setFailed(true); return }
    photoBlob(endpoint, readJWT())
      .then(blob => {
        if (cancelled) return
        const u = URL.createObjectURL(blob)
        objUrl.current = u
        setSrc(u)
      })
      .catch(() => { if (!cancelled) setFailed(true) })

    return () => { cancelled = true; clear() }
  }, [endpoint, visible])

  if (src) return <img src={src} alt="Property (Street View)" loading="lazy" className={className} />
  // Lazy: keep a sized placeholder to observe until we know the result; collapse
  // once we learn there's no photo. Eager mode renders nothing until loaded.
  if (lazy && !failed) return <div ref={boxRef} className={className} aria-hidden="true" />
  return null
}
