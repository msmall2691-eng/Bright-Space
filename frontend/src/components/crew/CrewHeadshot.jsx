/**
 * Your photo — the face a customer sees before you walk into their house.
 *
 * SELF-SERVICE ONLY, and the copy on this screen is the consent. There is no
 * office upload path (see migration 109), so this control is the single place
 * a headshot can come from, which makes it the single place that has to say
 * plainly where the photo ends up. It does, above the button, before the file
 * picker opens — not in a tooltip and not after the fact.
 *
 * Removing is one tap and takes effect everywhere, because a face you can't
 * easily take down is a face you never really chose to put up.
 */
import { useEffect, useRef, useState } from 'react'
import { Camera, Trash2, UserRound } from 'lucide-react'
import { del, upload } from '../../api'
import { prepareForUpload } from '../../utils/imageDownscale'
import { ErrorNote } from './primitives'

// The JWT straight from localStorage (same key api.js uses), so we can send it
// on the image fetch below. Read inline rather than importing a named api
// export to match PropertyPhoto — keeps widely-mocked ../api out of the way.
function readJWT() {
  try { return localStorage.getItem('brightbase_jwt') } catch { return null }
}

export default function CrewHeadshot({ photoUrl, onChange, disabled = false }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Bumped on every change so the photo refetches: the URL is stable by design
  // (it's keyed on the user, not the upload), so without this a replaced photo
  // would keep showing the old one.
  const [rev, setRev] = useState(0)

  // The headshot endpoint (/api/crew/photo/:id) is auth-gated — a plain
  // <img src> can't send the Bearer token, so it 401'd into a broken image and
  // the cleaner's own photo never showed. Fetch it with the token as a blob and
  // render an object URL instead (the same pattern as PropertyPhoto).
  const [src, setSrc] = useState(null)
  const objUrl = useRef(null)
  useEffect(() => {
    const clear = () => { if (objUrl.current) { URL.revokeObjectURL(objUrl.current); objUrl.current = null } }
    setSrc(null); clear()
    if (!photoUrl) return undefined
    let cancelled = false
    const token = readJWT()
    fetch(photoUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then(blob => {
        if (cancelled) return
        const u = URL.createObjectURL(blob)
        objUrl.current = u
        setSrc(u)
      })
      .catch(() => { /* leave the placeholder up; upload errors surface separately */ })
    return () => { cancelled = true; clear() }
  }, [photoUrl, rev])

  const pick = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''            // let the same file be re-picked after a failure
    if (!file || disabled) return
    setBusy(true); setError(null)
    try {
      const { blob, filename } = await prepareForUpload(file)
      const fd = new FormData()
      // FormData, via upload() — post() JSON-stringifies its body, which turns
      // a FormData into "{}" and 422s. This has bitten the document uploads.
      fd.append('file', blob, filename)
      const res = await upload('/api/crew/me/photo', fd)
      setRev(r => r + 1)
      onChange?.(res?.photo_url || null)
    } catch (err) {
      setError(err.detail || err.message || 'Could not upload that photo')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (disabled) return
    setBusy(true); setError(null)
    try {
      await del('/api/crew/me/photo')
      setRev(r => r + 1)
      onChange?.(null)
    } catch (err) {
      setError(err.detail || err.message || 'Could not remove that photo')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-full overflow-hidden bg-bg-2 border border-hairline shrink-0 flex items-center justify-center">
          {src ? (
            <img src={src} alt="Your photo" className="w-full h-full object-cover" />
          ) : (
            <UserRound className="w-7 h-7 text-ink-3" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-ink-2">Your photo</div>
          <p className="text-[11px] text-ink-3 leading-snug mt-0.5">
            Customers see this and your first name before your visit, so they
            know who&rsquo;s at the door. Nobody else sees it.
          </p>
        </div>
      </div>

      {/* Changing a headshot is the cleaner's own; in an office preview the
          controls are hidden (and the handlers above no-op) so a tap can't
          fire a cleaner-only upload/delete under the office session. */}
      {!disabled && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[13px] font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-60">
            <Camera className="w-4 h-4" aria-hidden="true" />
            {busy ? 'Working…' : photoUrl ? 'Change photo' : 'Add a photo'}
          </button>
          {photoUrl && (
            <button type="button" onClick={remove} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[13px] font-medium text-ink-2 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-60">
              <Trash2 className="w-4 h-4" aria-hidden="true" /> Remove
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={pick} />
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>
    </div>
  )
}
