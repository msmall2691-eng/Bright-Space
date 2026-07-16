import { useEffect, useRef, useState } from 'react'
import { getJWT } from '../api'

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
 *  a paid Street View call, so list cards use lazy to only load what's seen. */
export default function PropertyPhoto({ address, className = '', lazy = false }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(!lazy)
  const boxRef = useRef(null)
  const objUrl = useRef(null)

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

    const a = (address || '').trim()
    if (a.length < 5) { setFailed(true); return }
    const token = getJWT()
    fetch(`/api/quotes/property-photo?address=${encodeURIComponent(a)}`, {
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
  }, [address, visible])

  if (src) return <img src={src} alt="Property (Street View)" loading="lazy" className={className} />
  // Lazy: keep a sized placeholder to observe until we know the result; collapse
  // once we learn there's no photo. Eager mode renders nothing until loaded.
  if (lazy && !failed) return <div ref={boxRef} className={className} aria-hidden="true" />
  return null
}
