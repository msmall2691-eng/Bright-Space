import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, RefreshCw, ChevronDown, ChevronRight, Ban, Unlink } from 'lucide-react'
import { get, post, patch } from '../../api'
import { toast } from '../../utils/toastBus'
import { confirmDialog } from '../../utils/confirmBus'

/** Schedule audit panel — surfaces the same duplicate-jobs + orphaned-shift
 *  findings the background audit logs (GET /api/jobs/audit), and lets the
 *  operator resolve each with one click:
 *   - a duplicate job → Cancel it (PATCH status=cancelled, which also pulls it
 *     off Google Calendar + Connecteam);
 *   - an orphaned Connecteam shift → Remove it (POST /{id}/undispatch).
 *  Renders nothing on a clean schedule. `refreshKey` re-scans when the parent
 *  mutates the schedule; `onResolved` lets the parent refresh its own view. */
export default function ScheduleAuditPanel({ refreshKey = 0, onResolved }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(null)

  const scan = useCallback(() => {
    setLoading(true)
    get('/api/jobs/audit')
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { scan() }, [scan, refreshKey])

  const dupes = data?.duplicate_jobs || []
  const orphans = data?.orphaned_shifts || []
  if (!data || (dupes.length === 0 && orphans.length === 0)) return null

  const cancelJob = async (jobId) => {
    if (!(await confirmDialog(`Cancel duplicate Job #${jobId}? It'll be marked cancelled and pulled off the calendar + Connecteam.`,
      { confirmLabel: 'Cancel job', danger: true }))) return
    setBusy(`job-${jobId}`)
    try {
      await patch(`/api/jobs/${jobId}`, { status: 'cancelled' })
      toast('Duplicate cancelled')
      scan(); onResolved?.()
    } catch (e) { toast(e?.detail || e?.message || 'Failed to cancel', 'error') }
    finally { setBusy(null) }
  }

  const removeShifts = async (jobId) => {
    setBusy(`orphan-${jobId}`)
    try {
      await post(`/api/jobs/${jobId}/undispatch`, {})
      toast('Orphaned shifts removed from Connecteam')
      scan(); onResolved?.()
    } catch (e) { toast(e?.detail || e?.message || 'Failed to remove shifts', 'error') }
    finally { setBusy(null) }
  }

  const total = dupes.length + orphans.length

  return (
    <div className="mx-3 my-2 rounded-xl border border-amber-300 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-800 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-[13px] font-semibold text-amber-800 dark:text-amber-300 flex-1">
          Schedule needs attention — {dupes.length} duplicate{dupes.length === 1 ? '' : 's'}, {orphans.length} orphaned shift{orphans.length === 1 ? '' : 's'}
        </span>
        <span onClick={e => { e.stopPropagation(); scan() }} title="Re-scan"
          className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900 text-amber-700">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-amber-600" /> : <ChevronRight className="w-4 h-4 text-amber-600" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {dupes.map((g, i) => (
            <div key={`d${i}`} className="rounded-lg bg-panel border border-hairline p-2.5">
              <div className="text-[11px] font-semibold text-ink-2 mb-1.5">
                Duplicate · {g.date} {g.start_time?.slice(0, 5)} · {g.job_type?.replace('_', ' ')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(g.job_ids || []).map((jid, k) => (
                  <span key={jid} className="inline-flex items-center gap-1.5 text-[12px] bg-bg-2 border border-hairline rounded-lg pl-2 pr-1 py-1">
                    <span className="text-ink truncate max-w-[10rem]">#{jid} {(g.titles || [])[k] || ''}</span>
                    <button onClick={() => cancelJob(jid)} disabled={busy === `job-${jid}`}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 hover:bg-red-50 rounded px-1.5 py-0.5 disabled:opacity-50">
                      <Ban className="w-3 h-3" /> Cancel
                    </button>
                  </span>
                ))}
              </div>
              <p className="text-[10.5px] text-ink-3 mt-1.5">Keep one, cancel the rest.</p>
            </div>
          ))}

          {orphans.map((o, i) => (
            <div key={`o${i}`} className="rounded-lg bg-panel border border-hairline p-2.5 flex items-center justify-between gap-2">
              <div className="text-[12px] text-ink min-w-0">
                <span className="font-medium">Job #{o.job_id}</span>
                <span className="text-ink-3"> ({o.status}) still has {(o.shift_ids || []).length} Connecteam shift{(o.shift_ids || []).length === 1 ? '' : 's'}</span>
              </div>
              <button onClick={() => removeShifts(o.job_id)} disabled={busy === `orphan-${o.job_id}`}
                className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50 rounded-lg px-2 py-1 disabled:opacity-50">
                <Unlink className="w-3.5 h-3.5" /> Remove shifts
              </button>
            </div>
          ))}
          <p className="text-[10.5px] text-ink-3">This runs automatically every few hours too — you don't have to check it.</p>
        </div>
      )}
    </div>
  )
}
