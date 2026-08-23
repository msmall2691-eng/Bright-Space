/**
 * Bottom sheet for job photos on My Day — the cleaner-facing capture flow.
 *
 * Opens from the job card's Photos button. Tag defaults to "before" until the
 * job is marked done, then "after" — matching when each kind of photo is
 * actually taken, so most of the time the cleaner just taps the camera.
 *
 * Files are downscaled client-side (see utils/imageDownscale.js) and uploaded
 * one at a time — sequential keeps memory flat on old phones and makes the
 * "2 of 5" progress honest on slow connections. A failed file reports which
 * one and keeps the rest.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Images, X } from 'lucide-react'
import { del, get, upload } from '../../api'
import { AuthImage, Skeleton } from '../ui'
import { prepareForUpload } from '../../utils/imageDownscale'
import { onCellular, enqueuePhoto, flushPhotoQueue, subscribeQueue } from './photoQueue'
import { ErrorNote, Sheet } from './primitives'

const KIND_LABEL = { before: 'Before', after: 'After' }

export default function JobPhotoSheet({ job, onClose }) {
  const [photos, setPhotos] = useState(null)      // null = loading
  const [error, setError] = useState(null)
  const [kind, setKind] = useState(job.status === 'completed' ? 'after' : 'before')
  const [progress, setProgress] = useState(null)  // { done, total } while uploading
  // Cellular data-saver: photos queue for WiFi where the platform reports the
  // connection type (see photoQueue.js). Sampled when the sheet opens.
  const [cellular] = useState(() => onCellular())
  const [queued, setQueued] = useState(0)          // photos waiting, all jobs
  const [sendingNow, setSendingNow] = useState(false)
  const cameraRef = useRef(null)
  const galleryRef = useRef(null)

  useEffect(() => subscribeQueue(setQueued), [])

  const refresh = useCallback(() => {
    return get(`/api/crew/jobs/${job.id}/photos`)
      .then(setPhotos)
      .catch(e => setError(e.detail || e.message || 'Could not load photos'))
  }, [job.id])

  useEffect(() => { refresh() }, [refresh])

  const busy = progress != null || sendingNow

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setError(null)
    // On cellular, photos go to the on-device queue instead of straight up the
    // cell link ("will send on WiFi", Send-now to override). If the queue is
    // unavailable or full, fall through to a normal direct upload.
    const defer = onCellular()
    setProgress({ done: 0, total: files.length })
    for (let i = 0; i < files.length; i++) {
      try {
        const { blob, filename } = await prepareForUpload(files[i])
        const wasQueued = defer && await enqueuePhoto({
          url: `/api/crew/jobs/${job.id}/photos`, blob, filename, fields: { kind },
        })
        if (!wasQueued) {
          const form = new FormData()
          form.append('file', blob, filename)
          form.append('kind', kind)
          await upload(`/api/crew/jobs/${job.id}/photos`, form)
        }
        setProgress({ done: i + 1, total: files.length })
      } catch (e) {
        setError(`Photo ${i + 1} of ${files.length} didn't upload — ${e.message || 'try again'}`)
        break
      }
    }
    setProgress(null)
    refresh()
  }, [job.id, kind, refresh])

  // The cleaner's override: push the whole queue up over cellular, now.
  const sendNow = useCallback(async () => {
    setSendingNow(true); setError(null)
    try {
      await flushPhotoQueue({ force: true })
      await refresh()
    } finally {
      setSendingNow(false)
    }
  }, [refresh])

  const removePhoto = useCallback(async (photoId) => {
    setError(null)
    try {
      await del(`/api/crew/jobs/${job.id}/photos/${photoId}`)
      setPhotos(ps => (ps || []).filter(p => p.id !== photoId))
    } catch (e) {
      setError(e.detail || e.message || 'Could not remove the photo')
    }
  }, [job.id])

  return (
    <Sheet onClose={onClose} busy={busy}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-ink">Photos</div>
            <div className="text-[13px] text-ink-3 mt-0.5 truncate">
              {job.property_name || job.title}
            </div>
          </div>
          <button onClick={() => { if (!busy) onClose() }}
            className="p-1.5 -m-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Before/After tag for the NEXT photos taken */}
        <div className="grid grid-cols-2 rounded-lg border border-hairline overflow-hidden text-[13px] font-semibold">
          {['before', 'after'].map(k => (
            <button key={k} onClick={() => setKind(k)} disabled={busy}
              className={`py-2 transition-colors ${kind === k
                ? 'bg-blue-600 text-white'
                : 'bg-panel text-ink-2 hover:bg-bg-2'}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => cameraRef.current?.click()} disabled={busy}
            className="text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <Camera className="w-4 h-4" /> Camera
          </button>
          <button onClick={() => galleryRef.current?.click()} disabled={busy}
            className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <Images className="w-4 h-4" /> Gallery
          </button>
        </div>
        {/* capture="environment" jumps straight to the rear camera on phones;
            the Gallery input leaves it off so already-taken shots work too. */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple
          className="hidden" onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
        <input ref={galleryRef} type="file" accept="image/*" multiple
          className="hidden" onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />

        {cellular && queued === 0 && !progress && (
          /* Quiet heads-up BEFORE the first shot: cellular detected, photos
             will wait. Ties back to the job card's House WiFi block. */
          <p className="text-[11px] text-ink-3 flex items-start gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-[5px]" />
            You're on cellular — photos will wait and send on WiFi. Joining the
            house WiFi (on the job card) sends them free.
          </p>
        )}

        {queued > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
            <span className="text-[12px] text-ink-2 flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              {queued} photo{queued > 1 ? 's' : ''} waiting for WiFi
            </span>
            <button onClick={sendNow} disabled={busy}
              className="shrink-0 min-h-9 text-[12px] font-medium text-ink-2 border border-hairline-2 rounded-md px-2.5 py-1 hover:bg-bg-2 disabled:opacity-60 transition-colors">
              {sendingNow ? 'Sending…' : 'Send now'}
            </button>
          </div>
        )}

        {progress && (
          <div className="text-[12px] text-ink-2 bg-bg border border-hairline rounded-lg px-3 py-2">
            Saving {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>

        {photos === null ? (
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map(i => <Skeleton key={i} className="aspect-square rounded-lg" />)}
          </div>
        ) : photos.length === 0 ? (
          <p className="text-[12px] text-ink-3 text-center py-2">
            No photos yet — snap the rooms before you start, and again when you finish.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {photos.map(p => (
              <div key={p.id} className="relative aspect-square">
                <AuthImage src={p.url} alt={p.kind || 'job photo'}
                  className="w-full h-full object-cover rounded-lg border border-hairline" />
                {p.kind && (
                  <span className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white ${p.kind === 'before' ? 'bg-slate-600/90' : 'bg-emerald-600/90'}`}>
                    {KIND_LABEL[p.kind]}
                  </span>
                )}
                {p.mine && (
                  <button onClick={() => removePhoto(p.id)} disabled={busy}
                    aria-label="Remove photo"
                    className="absolute -top-1.5 -right-1.5 grid place-items-center w-6 h-6 rounded-full bg-ink text-bg shadow">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </Sheet>
  )
}
