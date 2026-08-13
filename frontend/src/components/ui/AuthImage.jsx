/**
 * <img> for authenticated endpoints. A plain <img src> can't carry the JWT
 * Authorization header, so job photos (and anything else served behind auth)
 * would 401. This fetches the bytes with the token, shows them via an object
 * URL, and revokes it on unmount so a long gallery session doesn't leak blobs.
 *
 * The photo endpoints send Cache-Control, so the underlying fetch hits the
 * HTTP cache on revisits — this component doesn't need its own cache.
 */
import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { getJWT } from '../../api'

export default function AuthImage({ src, alt = '', className = '', onClick }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!src) return undefined
    let cancelled = false
    let objUrl = null
    setUrl(null)
    setFailed(false)
    const token = getJWT()
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then(blob => {
        objUrl = URL.createObjectURL(blob)
        if (cancelled) URL.revokeObjectURL(objUrl)
        else setUrl(objUrl)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [src])

  if (failed) {
    return (
      <div className={`grid place-items-center bg-bg-2 text-ink-3 ${className}`}>
        <ImageOff className="w-5 h-5" />
      </div>
    )
  }
  if (!url) {
    return <div className={`bg-bg-2 animate-pulse ${className}`} />
  }
  return <img src={url} alt={alt} className={className} onClick={onClick} loading="lazy" />
}
