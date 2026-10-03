import { useEffect, useRef, useState } from 'react'

// Read the JWT straight from localStorage rather than importing it from
// ../api. This component is pulled into very widely-rendered surfaces (the
// crew JobCard, the office PropertyDetail), and importing a named api export
// would make every test that partially mocks ../api throw the moment it
// rendered one of those with an address. Same key api.getJWT uses.
function readJWT() {
  try { return localStorage.getItem('brightbase_jwt') } catch { return null }
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
    const token = readJWT()
    fetch(endpoint, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
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
