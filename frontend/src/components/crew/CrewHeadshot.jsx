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
import { useRef, useState } from 'react'
import { Camera, Trash2, UserRound } from 'lucide-react'
import { del, upload } from '../../api'
import { prepareForUpload } from '../../utils/imageDownscale'
import { ErrorNote } from './primitives'

export default function CrewHeadshot({ photoUrl, onChange, disabled = false }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Bumped on every change so the <img> refetches: the URL is stable by
  // design (it's keyed on the user, not the upload), so without this a
  // replaced photo keeps showing the old one out of the browser cache.
  const [rev, setRev] = useState(0)

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
          {photoUrl ? (
            <img src={`${photoUrl}?v=${rev}`} alt="Your photo"
              className="w-full h-full object-cover" />
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
