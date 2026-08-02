import { useMemo, useRef, useState } from 'react'
import { X, CheckCircle, Camera, Trash2 } from 'lucide-react'
import Button from '../ui/Button'
import { DEFAULT_CHECKLIST } from './constants'
import { readFileAsUpload, mergePhotosForSubmit, MAX_FILE_BYTES, MAX_TOTAL_PHOTOS } from './completePhotos'

/** Bottom-sheet modal for marking a visit complete. Renders the default
 *  checklist, preserves any prior partial completion state (so re-opening
 *  doesn't lose work), and lets the cleaner either snap/upload photos from
 *  their phone OR paste URLs (audit §15 — the upload path replaces the old
 *  "coming later" placeholder while keeping the paste path as an escape
 *  hatch). Persists via the parent-supplied onComplete({ checklist_results,
 *  photos }) callback; the modal stays open on error so no work is lost. */
export default function CompleteVisitModal({ visit, onClose, onComplete }) {
  const [checks, setChecks] = useState(() => {
    const prior = visit.checklist_results || {}
    const seed = {}
    DEFAULT_CHECKLIST.forEach(t => { seed[t] = !!prior[t] })
    Object.keys(prior).forEach(t => { if (!(t in seed)) seed[t] = !!prior[t] })
    return seed
  })

  // Split the incoming photos into two lanes so each has its own UI: pasted
  // URLs live in a textarea, uploaded blobs live as staged dicts we render
  // as thumbnails. On submit we merge them back into one array.
  const [staged, setStaged] = useState(() => {
    const prior = Array.isArray(visit.photos) ? visit.photos : []
    return prior.filter(p => p && typeof p === 'object' && p.data_url)
  })
  const [urlLines, setUrlLines] = useState(() => {
    const prior = Array.isArray(visit.photos) ? visit.photos : []
    return prior.filter(p => typeof p === 'string').join('\n')
  })

  const [uploadError, setUploadError] = useState('')
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef(null)

  const toggle = (task) => setChecks(c => ({ ...c, [task]: !c[task] }))
  const doneCount = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length

  const pastedCount = useMemo(
    () => urlLines.split('\n').map(s => s.trim()).filter(Boolean).length,
    [urlLines],
  )
  const remainingSlots = Math.max(0, MAX_TOTAL_PHOTOS - staged.length - pastedCount)

  const handleFiles = async (fileList) => {
    setUploadError('')
    const files = Array.from(fileList || [])
    if (!files.length) return

    if (files.length > remainingSlots) {
      setUploadError(`Only ${remainingSlots} more photo${remainingSlots === 1 ? '' : 's'} can be attached (max ${MAX_TOTAL_PHOTOS}).`)
      return
    }

    const additions = []
    for (const file of files) {
      // Some mobile browsers (e.g. certain Android camera intents) hand back a
      // File with an empty `type`. The picker's `accept="image/*"` has already
      // gated by extension and readFileAsUpload falls back to image/jpeg — only
      // reject when the browser explicitly said it's a non-image mime.
      if (file.type && !file.type.startsWith('image/')) {
        setUploadError(`"${file.name}" isn't an image file.`)
        return
      }
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(`"${file.name}" is over ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB — please resize or pick a smaller photo.`)
        return
      }
      try {
        additions.push(await readFileAsUpload(file))
      } catch {
        setUploadError(`Could not read "${file.name}".`)
        return
      }
    }
    setStaged(prev => [...prev, ...additions])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeStaged = (idx) => setStaged(prev => prev.filter((_, i) => i !== idx))

  const submit = async () => {
    // Re-check the total at submit time: handleFiles caps the upload lane,
    // but the paste-URL textarea has no per-keystroke limit — a cleaner who
    // dumps 30 links would otherwise bypass the 20-photo guardrail entirely
    // and bloat the job.photos JSON column.
    const photos = mergePhotosForSubmit(staged, urlLines)
    if (photos.length > MAX_TOTAL_PHOTOS) {
      setUploadError(`${photos.length} photos attached — please remove some (max ${MAX_TOTAL_PHOTOS}).`)
      return
    }
    setUploadError('')
    setSaving(true)
    try {
      await onComplete({ checklist_results: checks, photos })
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-panel w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline sticky top-0 bg-panel">
          <h3 className="text-base font-bold text-ink">Complete visit</h3>
          <button onClick={onClose} className="p-2 -m-1 rounded-lg hover:bg-bg-2 text-ink-3">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2 uppercase">Checklist</p>
              <span className="text-xs font-semibold text-ink-3 tabular-nums">{doneCount}/{total}</span>
            </div>
            <div className="space-y-1.5">
              {Object.keys(checks).map(task => (
                <button
                  key={task}
                  type="button"
                  onClick={() => toggle(task)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                    checks[task]
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : 'bg-panel border-hairline text-ink hover:bg-bg'
                  }`}
                >
                  <span className={`w-4 h-4 rounded flex items-center justify-center text-[11px] ${
                    checks[task] ? 'bg-green-500 text-white' : 'border border-hairline'
                  }`}>{checks[task] ? '✓' : ''}</span>
                  {task}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2 uppercase">Photos</p>
              <span className="text-xs font-semibold text-ink-3 tabular-nums">
                {staged.length + pastedCount}/{MAX_TOTAL_PHOTOS}
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={e => handleFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={remainingSlots === 0 || saving}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-hairline text-sm text-ink hover:bg-bg disabled:opacity-50"
            >
              <Camera className="w-4 h-4" />
              Take or upload photos
            </button>

            {staged.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {staged.map((p, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-hairline bg-bg">
                    <img src={p.data_url} alt={p.name || `Photo ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeStaged(i)}
                      aria-label={`Remove ${p.name || `photo ${i + 1}`}`}
                      className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {uploadError && (
              <p className="mt-2 text-[11px] text-red-600">{uploadError}</p>
            )}

            <div className="mt-3">
              <p className="text-[11px] font-semibold text-ink-3 uppercase mb-1">Or paste links</p>
              <textarea
                value={urlLines}
                onChange={e => setUrlLines(e.target.value)}
                rows={2}
                placeholder="One photo URL per line"
                className="w-full px-3 py-2 border border-hairline rounded-lg text-sm placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-blue-400"
              />
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-hairline flex gap-2 sticky bottom-0 bg-panel">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" className="flex-1" onClick={submit} disabled={saving}>
            <CheckCircle className="w-4 h-4 mr-2" />
            {saving ? 'Saving…' : 'Mark complete'}
          </Button>
        </div>
      </div>
    </div>
  )
}
