import { useEffect, useRef, useState } from 'react'
import { getJWT } from '../api'

/** Front-of-house Street View photo for an address — the SAME photo the
 *  customer sees on their quote, shown to staff on the Requests drawer and the
 *  quote composer (keyed on the address, so it works before a quote exists).
 *
 *  The photo endpoint is staff-authenticated (Bearer token), so a plain
 *  <img src> can't load it — we fetch it as a blob with the auth header and
 *  render an object URL. Renders nothing when photos are off, no key is set, or
 *  Google has no imagery (a 404), so a missing photo never leaves a broken tile. */
export default function PropertyPhoto({ address, className = '' }) {
  const [src, setSrc] = useState(null)
  const objUrl = useRef(null)

  useEffect(() => {
    let cancelled = false
    const clear = () => { if (objUrl.current) { URL.revokeObjectURL(objUrl.current); objUrl.current = null } }
    setSrc(null); clear()

    const a = (address || '').trim()
    if (a.length < 5) return
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
      .catch(() => { /* no photo — stay hidden */ })

    return () => { cancelled = true; clear() }
  }, [address])

  if (!src) return null
  return <img src={src} alt="Property (Street View)" loading="lazy" className={className} />
}
