/**
 * Office-side photo gallery for the Job page — the "did the crew photograph
 * it" view. Reads the same crew photo endpoints My Day writes to
 * (/api/crew/jobs/{id}/photos; admin/manager/viewer pass the role gate there).
 *
 * Also renders `photos_legacy` — entries the old Complete-visit modal stored
 * inline on Job.photos (data URLs / pasted links). Those were write-only
 * before this card existed; they show read-only under the same grid so
 * nothing already captured is lost.
 */
import { useCallback, useEffect, useState } from 'react'
import { Camera, X } from 'lucide-react'
import { del, get } from '../../api'
import { AuthImage } from '../ui'
import { toast } from '../../utils/toastBus'
import { canEdit } from '../../utils/perms'

const KIND_BADGE = {
  before: 'bg-slate-600/90',
  after: 'bg-emerald-600/90',
}

function Badge({ kind }) {
  if (!kind) return null
  return (
    <span className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white ${KIND_BADGE[kind] || 'bg-slate-600/90'}`}>
      {kind}
    </span>
  )
}

/** A legacy Job.photos JSON entry → something renderable, or null. */
function legacySrc(entry) {
  if (typeof entry === 'string' && entry.trim()) return entry.trim()
  if (entry && typeof entry === 'object' && typeof entry.data_url === 'string') return entry.data_url
  return null
}

export default function JobPhotosCard({ jobId, legacy = [] }) {
  const [photos, setPhotos] = useState(null)   // null = loading
  const [viewer, setViewer] = useState(null)   // { src, authed } | null
  const legacyEntries = (legacy || []).map(legacySrc).filter(Boolean)

  const load = useCallback(() => {
    get(`/api/crew/jobs/${jobId}/photos`)
      .then(setPhotos)
      .catch(() => setPhotos([]))
  }, [jobId])
  useEffect(() => { load() }, [load])

  const remove = async (photoId) => {
    try {
      await del(`/api/crew/jobs/${jobId}/photos/${photoId}`)
      setPhotos(ps => (ps || []).filter(p => p.id !== photoId))
    } catch {
      toast.error('Could not delete the photo')
    }
  }

  const count = (photos?.length || 0) + legacyEntries.length
  if (photos !== null && count === 0) return null   // no card until there's something to show

  return (
    <div className="bg-panel border border-hairline rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
          <Camera className="w-3.5 h-3.5 text-ink-3" /> Photos
        </div>
        {photos !== null && <span className="text-[11px] text-ink-3">{count}</span>}
      </div>

      {photos === null ? (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
          {[0, 1, 2].map(i => <div key={i} className="aspect-square rounded-lg bg-bg-2 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
          {photos.map(p => (
            <div key={p.id} className="relative aspect-square group">
              <AuthImage src={p.url} alt={p.kind || 'job photo'}
                onClick={() => setViewer({ src: p.url, authed: true, title: p.uploaded_by_name })}
                className="w-full h-full object-cover rounded-lg border border-hairline cursor-zoom-in" />
              <Badge kind={p.kind} />
              {canEdit() && (
                <button onClick={() => remove(p.id)} aria-label="Delete photo"
                  className="absolute -top-1.5 -right-1.5 hidden group-hover:grid place-items-center w-5 h-5 rounded-full bg-ink text-bg shadow">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {legacyEntries.map((src, i) => (
            <div key={`legacy-${i}`} className="relative aspect-square" title="From the completion form">
              <img src={src} alt="job photo"
                onClick={() => setViewer({ src, authed: false })}
                className="w-full h-full object-cover rounded-lg border border-hairline cursor-zoom-in opacity-90" />
            </div>
          ))}
        </div>
      )}

      {viewer && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4 cursor-zoom-out"
          onClick={() => setViewer(null)}>
          {viewer.authed
            ? <AuthImage src={viewer.src} alt="job photo" className="max-w-full max-h-full rounded-lg" />
            : <img src={viewer.src} alt="job photo" className="max-w-full max-h-full rounded-lg" />}
        </div>
      )}
    </div>
  )
}
