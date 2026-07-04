import { useState } from 'react'
import { X, CheckCircle } from 'lucide-react'
import Button from '../ui/Button'
import { DEFAULT_CHECKLIST } from './constants'

/** Bottom-sheet modal for marking a visit complete. Renders the default
 *  checklist, preserves any prior partial completion state (so re-opening
 *  doesn't lose work), and lets the cleaner paste photo URLs. Persists via
 *  the parent-supplied onComplete({ checklist_results, photos }) callback —
 *  the modal stays open on error so no work is lost. */
export default function CompleteVisitModal({ visit, onClose, onComplete }) {
  const [checks, setChecks] = useState(() => {
    const prior = visit.checklist_results || {}
    const seed = {}
    DEFAULT_CHECKLIST.forEach(t => { seed[t] = !!prior[t] })
    Object.keys(prior).forEach(t => { if (!(t in seed)) seed[t] = !!prior[t] })
    return seed
  })
  const [photos, setPhotos] = useState(() => (visit.photos || []).join('\n'))
  const [saving, setSaving] = useState(false)

  const toggle = (task) => setChecks(c => ({ ...c, [task]: !c[task] }))
  const doneCount = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length

  const submit = async () => {
    setSaving(true)
    try {
      const photoUrls = photos.split('\n').map(s => s.trim()).filter(Boolean)
      await onComplete({ checklist_results: checks, photos: photoUrls })
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-panel w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline sticky top-0 bg-panel">
          <h3 className="text-base font-bold text-ink">Complete visit</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-bg-2 text-ink-3">
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
            <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Photo links (optional)</p>
            <textarea
              value={photos}
              onChange={e => setPhotos(e.target.value)}
              rows={3}
              placeholder="One photo URL per line"
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
            />
            <p className="text-[11px] text-ink-3 mt-1">Paste links to photos (e.g. from your phone's cloud). Direct upload coming later.</p>
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
