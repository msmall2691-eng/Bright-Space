import { useEffect, useState, useCallback } from 'react'
import { Zap, Check, X, ChevronRight, Sparkles, ChevronDown } from 'lucide-react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'
import { SOFT_CARD } from './constants'

/**
 * NeedsYouNow — the dashboard's single action list. Merges everything that
 * actually needs the owner into one prioritized, one-tap-to-act feed:
 *   1. Customer reschedule approvals (busy-slot holds) — approve/decline inline
 *   2. Attention items (overdue replies, late starts, unassigned, past-due)
 * Nothing else on the dashboard should nag — this is the command center.
 */
const dotFor = (tone) => ({
  red: 'bg-red-500', amber: 'bg-amber-500', rose: 'bg-rose-500', blue: 'bg-blue-500', violet: 'bg-violet-500',
}[tone] || 'bg-ink-3')

const CAP = 6  // show this many by default; the rest collapse behind "Show all"

export function NeedsYouNow({ attention = [], loading, navigate }) {
  const [reqs, setReqs] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [expanded, setExpanded] = useState(false)

  const loadReqs = useCallback(() => {
    get('/api/jobs/reschedule-requests').then(d => setReqs(d?.requests || [])).catch(() => setReqs([]))
  }, [])
  // Poll so a customer's busy-slot reschedule request appears here without a
  // manual reload — this is a time-sensitive approval queue. Pause while the
  // tab is hidden to avoid pointless background traffic.
  useEffect(() => {
    loadReqs()
    let timer = null
    const start = () => { if (!timer) timer = setInterval(loadReqs, 60000) }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => (document.hidden ? stop() : (loadReqs(), start()))
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [loadReqs])

  const act = async (jobId, action) => {
    setBusyId(jobId)
    try {
      await post(`/api/jobs/${jobId}/${action}-reschedule`, {})
      toast(action === 'approve' ? 'Approved — visit moved' : 'Request dismissed')
      setReqs(rs => (rs || []).filter(r => r.job_id !== jobId))
    } catch (e) {
      toast(e?.message || `Could not ${action}`, 'error')
    } finally { setBusyId(null) }
  }

  const fmt = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' }) : ''

  const reschedules = reqs || []
  const total = reschedules.length + attention.length
  const isLoading = loading && reqs === null

  return (
    <section className={`${SOFT_CARD} overflow-hidden`}>
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-hairline">
        <span className="bb-icon-chip grid place-items-center w-8 h-8 rounded-xl shrink-0 bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300">
          <Zap className="w-4 h-4" />
        </span>
        <h2 className="text-sm font-semibold text-ink">Needs you now</h2>
        {total > 0 && (
          <span className="text-[11px] font-bold text-white bg-indigo-600 px-1.5 py-0.5 rounded-full">{total}</span>
        )}
      </div>

      {isLoading ? (
        <div className="px-5 py-4 space-y-2.5">
          {[0, 1, 2].map(i => <div key={i} className="h-10 rounded-lg bg-bg-2 animate-pulse" />)}
        </div>
      ) : total === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-6">
          <span className="grid place-items-center w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 mb-2.5">
            <Sparkles className="w-5 h-5" />
          </span>
          <p className="text-sm font-semibold text-ink">You're all caught up</p>
          <p className="text-[12px] text-ink-3 mt-0.5">No approvals, replies, or overdue items right now.</p>
        </div>
      ) : (() => {
        // Reschedule approvals first (time-sensitive + inline actions), then
        // the attention feed. Cap the combined list; the rest collapse.
        const nodes = [
          ...reschedules.map(r => (
            <div key={`rq-${r.job_id}`} className="flex items-start gap-3 px-5 py-3">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-violet-500" />
              <button onClick={() => navigate(`/jobs/${r.job_id}`)} className="flex-1 min-w-0 text-left group">
                <div className="text-[13px] font-medium text-ink truncate group-hover:text-indigo-600">
                  {r.needs_approval ? 'Reschedule to approve' : 'Reschedule requested'} · {r.client_name || r.title || `Job #${r.job_id}`}
                </div>
                <div className="text-[11px] text-ink-3 truncate">
                  {r.needs_approval
                    ? <>{fmt(r.current_date)} → <span className="text-amber-600 dark:text-amber-300 font-medium">{fmt(r.requested_date)}</span>{r.requested_scope === 'future' ? ' · + all future' : ''} — busy slot</>
                    : (r.message ? `“${r.message}”` : 'Customer asked to move this visit')}
                </div>
              </button>
              {r.needs_approval ? (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button disabled={busyId === r.job_id} onClick={() => act(r.job_id, 'approve')}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white">
                    <Check className="w-3 h-3" /> Approve
                  </button>
                  <button disabled={busyId === r.job_id} onClick={() => act(r.job_id, 'decline')}
                    className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-bg-2 border border-hairline hover:bg-hairline text-ink-3" title="Dismiss">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <ChevronRight className="w-4 h-4 text-ink-3 shrink-0 mt-1" />
              )}
            </div>
          )),
          ...attention.map(p => (
            <button key={p.key} onClick={p.onClick}
              className="w-full text-left flex items-start gap-3 px-5 py-3 hover:bg-bg active:bg-bg-2 transition-colors">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotFor(p.tone)}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{p.title}</div>
                {p.sub && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{p.sub}</div>}
              </div>
              {p.action && <span className="text-[11px] font-semibold text-indigo-600 shrink-0 mt-1.5">{p.action}</span>}
            </button>
          )),
        ]
        const shown = expanded ? nodes : nodes.slice(0, CAP)
        const hidden = nodes.length - shown.length
        return (
          <>
            <div className="divide-y divide-hairline">{shown}</div>
            {(hidden > 0 || expanded) && (
              <button onClick={() => setExpanded(e => !e)}
                className="w-full flex items-center justify-center gap-1 py-2.5 text-[12px] font-semibold text-indigo-600 hover:bg-bg border-t border-hairline transition-colors">
                {expanded ? 'Show less' : `Show all ${nodes.length}`}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
            )}
          </>
        )
      })()}
    </section>
  )
}
