import { X, Wand2, Clock, User } from 'lucide-react'
import Button from '../ui/Button'

/** Two preview-then-confirm modals for the Tools menu. Both accept the
 *  parent-owned FSM state (null | {loading} | {preview:…} | {running})
 *  plus onCancel + onRun handlers. Nothing internal — closing / running
 *  is fully driven by the parent's setter. */

export function AutoAssignModal({ state, onCancel, onRun, empName }) {
  if (!state) return null
  const assigned = state.preview?.assigned || []
  const unassignable = state.preview?.unassignable || []
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => !state.running && onCancel()}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
          <div className="flex items-center gap-2.5 min-w-0">
            <Wand2 className="w-5 h-5 text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Auto-assign turnovers</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Available cleaners, balanced by daily load. Review before applying.</p>
            </div>
          </div>
          <button onClick={() => !state.running && onCancel()} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
          {state.loading ? (
            <div className="py-12 text-center text-[13px] text-ink-3">Finding available cleaners…</div>
          ) : (
            <>
              {assigned.length > 0 ? (
                <div className="space-y-1.5">
                  {assigned.map(a => (
                    <div key={a.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{a.title}</div>
                        <div className="text-[11px] text-ink-3">{a.date}</div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded shrink-0">
                        <User className="w-3 h-3" /> {empName(a.cleaner_id)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-[13px] text-ink-3">No turnovers could be auto-assigned.</div>
              )}
              {unassignable.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="text-[11px] font-semibold text-amber-700 mb-1">
                    {unassignable.length} couldn’t be filled (no available cleaner)
                  </div>
                  {unassignable.map(u => (
                    <div key={u.job_id} className="text-[11px] text-amber-700/90">{u.title} · {u.date}</div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={state.running}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onRun}
            disabled={state.loading || state.running || !assigned.length}>
            {state.running ? 'Assigning…' : `Assign ${assigned.length}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function FixTimesModal({ state, onCancel, onRun }) {
  if (!state) return null
  const jobs = state.preview?.jobs || []
  const bySource = state.bySource || {}
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => !state.running && onCancel()}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
          <div className="flex items-center gap-2.5 min-w-0">
            <Clock className="w-5 h-5 text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Fix missing job times</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Jobs showing "– –" get a sensible default (turnovers → property checkout, others → 9:00). Review before applying.</p>
            </div>
          </div>
          <button onClick={() => !state.running && onCancel()} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
          {state.loading ? (
            <div className="py-12 text-center text-[13px] text-ink-3">Checking job times…</div>
          ) : (
            <>
              {Object.keys(bySource).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(bySource).map(([src, n]) => (
                    <span key={src} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-bg-2 text-ink-2">
                      {src.replace(/_/g, ' ')}: {n}
                    </span>
                  ))}
                </div>
              )}
              {jobs.map(j => (
                <div key={j.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{j.title}</div>
                    <div className="text-[11px] text-ink-3">{j.scheduled_date} · {j.source.replace(/_/g, ' ')}</div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded shrink-0 tabular-nums">
                    {j.new_start}–{(j.new_end || '').slice(0, 5)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={state.running}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onRun}
            disabled={state.loading || state.running || !state.preview?.count}>
            {state.running ? 'Fixing…' : `Fix ${state.preview?.count || 0}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
