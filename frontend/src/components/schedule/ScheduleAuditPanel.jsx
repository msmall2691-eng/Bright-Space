import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ChevronDown, ChevronRight, Ban, Unlink, Send, ArrowDownLeft, Link2Off, Clock, Copy } from 'lucide-react'
import { get, post, patch } from '../../api'
import { toast } from '../../utils/toastBus'
import { confirmDialog } from '../../utils/confirmBus'

// Plain-English description + which resolve buttons to show, per drift type.
// (No jargon — "Keep BrightBase"/"orphaned shift" meant nothing to an operator.)
const DRIFT_META = {
  changed_in_connecteam: { label: 'The time was changed in Connecteam', pull: true, repush: true },
  conflict: { label: 'Changed in both BrightBase and Connecteam', pull: true, repush: true },
  reassigned_in_connecteam: { label: 'A different cleaner was set in Connecteam', repush: true },
  deleted_in_connecteam: { label: 'Its shift is no longer in Connecteam', repush: true, cancel: true },
  partially_deleted_in_connecteam: { label: 'Some of its shifts were removed in Connecteam', repush: true },
}
const when = (o) => o ? `${o.scheduled_date || '—'} ${(o.start_time || '').slice(0, 5)}`.trim() : '—'

/** Connecteam sync review — surfaces the duplicate-jobs + leftover-shift audit
 *  (GET /api/jobs/audit) and the live Connecteam drift scan
 *  (GET /api/jobs/connecteam-drift), each resolvable in one click, in plain
 *  language. Renders nothing on a clean schedule. */
export default function ScheduleAuditPanel({ refreshKey = 0, onResolved }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  const [drift, setDrift] = useState(null)

  const scan = useCallback(() => {
    setLoading(true)
    get('/api/jobs/audit').then(setData).catch(() => setData(null)).finally(() => setLoading(false))
    get('/api/jobs/connecteam-drift').then(setDrift).catch(() => setDrift(null))
  }, [])

  useEffect(() => { scan() }, [scan, refreshKey])

  const dupes = data?.duplicate_jobs || []
  const orphans = data?.orphaned_shifts || []
  const changes = drift?.changes || []
  const total = dupes.length + orphans.length + changes.length
  if (!data || total === 0) return null

  const applyDrift = async (jobId, action) => {
    if (action === 'cancel' && !(await confirmDialog(
      `Cancel this job? Its Connecteam shift is already gone — this marks the job cancelled in BrightBase too.`,
      { confirmLabel: 'Cancel job', danger: true }))) return
    setBusy(`drift-${jobId}-${action}`)
    try {
      await post('/api/jobs/connecteam-drift/apply', { job_id: jobId, action })
      toast.success(action === 'pull' ? 'Updated to match Connecteam'
        : action === 'repush' ? 'Re-sent to Connecteam' : 'Job cancelled')
      scan(); onResolved?.()
    } catch (e) { toast.error(e?.detail || e?.message || 'Could not apply that') }
    finally { setBusy(null) }
  }

  const resendable = changes.filter(c => (DRIFT_META[c.type] || {}).repush)
  const resendAll = async () => {
    if (!resendable.length) return
    if (!(await confirmDialog(
      `Re-send ${resendable.length} job${resendable.length === 1 ? '' : 's'} to Connecteam as fresh drafts? This replaces whatever is (or isn't) there now with what's in BrightBase.`,
      { confirmLabel: `Re-send ${resendable.length}` }))) return
    setBusy('resend-all')
    let ok = 0
    for (const c of resendable) {
      try { await post('/api/jobs/connecteam-drift/apply', { job_id: c.job_id, action: 'repush' }); ok++ }
      catch { /* keep going; report at the end */ }
    }
    ;(ok ? toast.success : toast.error)(
      ok === resendable.length ? `Re-sent ${ok} to Connecteam` : `Re-sent ${ok} of ${resendable.length} — re-scan for the rest`)
    setBusy(null); scan(); onResolved?.()
  }

  const cancelJob = async (jobId) => {
    if (!(await confirmDialog(`Cancel this duplicate job? It'll be pulled off the calendar and Connecteam.`,
      { confirmLabel: 'Cancel job', danger: true }))) return
    setBusy(`job-${jobId}`)
    try {
      await patch(`/api/jobs/${jobId}`, { status: 'cancelled' })
      toast.success('Duplicate cancelled'); scan(); onResolved?.()
    } catch (e) { toast.error(e?.detail || e?.message || 'Could not cancel') }
    finally { setBusy(null) }
  }

  const removeShifts = async (jobId) => {
    setBusy(`orphan-${jobId}`)
    try {
      await post(`/api/jobs/${jobId}/undispatch`, {})
      toast.success('Leftover shift removed'); scan(); onResolved?.()
    } catch (e) { toast.error(e?.detail || e?.message || 'Could not remove it') }
    finally { setBusy(null) }
  }

  const Btn = ({ onClick, disabled, icon: Icon, children, tone = 'default' }) => (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50 ${
        tone === 'primary' ? 'bg-indigo-600 text-white hover:bg-indigo-700'
        : tone === 'danger' ? 'text-rose-600 hover:bg-rose-500/10'
        : 'bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink'}`}>
      <Icon className="w-3.5 h-3.5" /> {children}
    </button>
  )

  return (
    <div className="no-print mx-3 my-2 bb-surface bg-panel border border-hairline rounded-2xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 bg-amber-500/15 text-amber-500">
          <ArrowDownLeft className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-ink">Connecteam sync — {total} to review</span>
          <span className="block text-[12px] text-ink-3">
            {changes.length > 0 && `${changes.length} changed in Connecteam`}
            {orphans.length > 0 && `${changes.length ? ' · ' : ''}${orphans.length} leftover shift${orphans.length === 1 ? '' : 's'}`}
            {dupes.length > 0 && `${(changes.length || orphans.length) ? ' · ' : ''}${dupes.length} duplicate${dupes.length === 1 ? '' : 's'}`}
          </span>
        </span>
        {resendable.length > 1 && (
          <span onClick={e => { e.stopPropagation(); resendAll() }}
            className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg px-3 py-1.5 shrink-0"
            title="Re-send all these jobs to Connecteam as fresh drafts">
            <Send className="w-3.5 h-3.5" /> {busy === 'resend-all' ? 'Re-sending…' : `Re-send all ${resendable.length}`}
          </span>
        )}
        <span onClick={e => { e.stopPropagation(); scan() }} title="Re-scan"
          className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-3 shrink-0">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {resendable.length > 1 && (
            <div className="sm:hidden">
              <Btn onClick={resendAll} disabled={busy === 'resend-all'} icon={Send} tone="primary">
                {busy === 'resend-all' ? 'Re-sending…' : `Re-send all ${resendable.length} to Connecteam`}
              </Btn>
            </div>
          )}

          {changes.map((c, i) => {
            const meta = DRIFT_META[c.type] || { label: 'Out of sync with Connecteam', repush: true }
            const timed = c.type === 'changed_in_connecteam' || c.type === 'conflict'
            return (
              <div key={`c${i}`} className="rounded-xl bg-bg-2/40 border border-hairline p-3">
                <div className="text-[13px] text-ink font-medium truncate">{c.title || `Job #${c.job_id}`}</div>
                <div className="text-[12px] text-ink-3 mt-0.5">{meta.label}</div>
                {timed && (
                  <div className="text-[12px] mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                    <span className="text-ink-3">Here: <b className="text-ink">{when(c.brightbase)}</b></span>
                    <span className="text-ink-3">Connecteam: <b className="text-indigo-500">{when(c.connecteam)}</b></span>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {meta.repush && (
                    <Btn onClick={() => applyDrift(c.job_id, 'repush')} disabled={busy === `drift-${c.job_id}-repush`} icon={Send} tone="primary">
                      Re-send to Connecteam
                    </Btn>
                  )}
                  {meta.pull && (
                    <Btn onClick={() => applyDrift(c.job_id, 'pull')} disabled={busy === `drift-${c.job_id}-pull`} icon={ArrowDownLeft}>
                      Use Connecteam’s version
                    </Btn>
                  )}
                  {meta.cancel && (
                    <Btn onClick={() => applyDrift(c.job_id, 'cancel')} disabled={busy === `drift-${c.job_id}-cancel`} icon={Ban} tone="danger">
                      Cancel this job
                    </Btn>
                  )}
                </div>
              </div>
            )
          })}

          {orphans.map((o, i) => (
            <div key={`o${i}`} className="rounded-xl bg-bg-2/40 border border-hairline p-3 flex items-center justify-between gap-2">
              <div className="text-[12.5px] text-ink-2 min-w-0">
                <Link2Off className="w-3.5 h-3.5 inline mr-1.5 text-ink-3" />
                A cancelled job still has a leftover shift in Connecteam.
              </div>
              <Btn onClick={() => removeShifts(o.job_id)} disabled={busy === `orphan-${o.job_id}`} icon={Unlink}>
                Remove it
              </Btn>
            </div>
          ))}

          {dupes.map((g, i) => (
            <div key={`d${i}`} className="rounded-xl bg-bg-2/40 border border-hairline p-3">
              <div className="text-[12.5px] text-ink-2">
                <Copy className="w-3.5 h-3.5 inline mr-1.5 text-ink-3" />
                Two jobs at the same time · {g.date} {g.start_time?.slice(0, 5)} — keep one, cancel the other.
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(g.job_ids || []).map((jid, k) => (
                  <Btn key={jid} onClick={() => cancelJob(jid)} disabled={busy === `job-${jid}`} icon={Ban} tone="danger">
                    Cancel {(g.titles || [])[k] || `#${jid}`}
                  </Btn>
                ))}
              </div>
            </div>
          ))}

          {drift?.unlinked_count > 0 && (
            <p className="text-[11px] text-ink-3 px-1">
              {drift.unlinked_count} shift{drift.unlinked_count === 1 ? '' : 's'} in Connecteam {drift.unlinked_count === 1 ? 'was' : 'were'} created directly there — nothing to bring in.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
