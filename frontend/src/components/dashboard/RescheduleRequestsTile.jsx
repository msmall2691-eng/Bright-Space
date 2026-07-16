import { useEffect, useState, useCallback } from 'react'
import { CalendarClock, Check, X, ChevronRight } from 'lucide-react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'

/** Dashboard queue of customer reschedule requests. Two kinds land here:
 *  a concrete self-reschedule that hit a busy slot (needs_approval → one-tap
 *  Approve moves the job + updates Google), and a plain "please move me"
 *  message request (Open opens the job to reschedule by hand). Hides itself
 *  when the queue is empty so it never adds noise. */
export function RescheduleRequestsTile({ navigate }) {
  const [rows, setRows] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(() => {
    get('/api/jobs/reschedule-requests')
      .then(d => setRows(d?.requests || []))
      .catch(() => setRows([]))
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (jobId, action) => {
    setBusyId(jobId)
    try {
      await post(`/api/jobs/${jobId}/${action}-reschedule`, {})
      toast(action === 'approve' ? 'Reschedule approved — visit moved' : 'Request dismissed')
      setRows(rs => (rs || []).filter(r => r.job_id !== jobId))
    } catch (e) {
      toast(e?.message || `Could not ${action} the request`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const fmt = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' }) : ''

  if (!rows || rows.length === 0) return null

  return (
    <div className="lg:col-span-2 bg-panel border border-amber-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-5 py-3.5 bg-amber-50 border-b border-amber-200">
        <CalendarClock className="w-4.5 h-4.5 text-amber-600" />
        <h2 className="font-semibold text-ink text-[15px]">Reschedule requests</h2>
        <span className="ml-2 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-600 text-white">{rows.length}</span>
      </div>
      <div className="divide-y divide-hairline">
        {rows.map(r => (
          <div key={r.job_id} className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button onClick={() => navigate(`/jobs/${r.job_id}`)}
              className="min-w-0 flex-1 text-left group">
              <p className="text-[13px] font-medium text-ink truncate group-hover:text-blue-600">
                {r.title || `Job #${r.job_id}`}
                {r.is_recurring && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-violet-600">recurring</span>}
              </p>
              <p className="text-[12px] text-ink-3 truncate">
                {r.client_name ? `${r.client_name} · ` : ''}
                {r.needs_approval
                  ? <>wants {fmt(r.current_date)} → <span className="text-amber-700 font-medium">{fmt(r.requested_date)}</span>
                      {r.requested_scope === 'future' ? ' (this + all future)' : ''} — busy slot</>
                  : (r.message ? `“${r.message}”` : 'asked to reschedule')}
              </p>
            </button>
            {r.needs_approval ? (
              <div className="flex items-center gap-1.5">
                <button disabled={busyId === r.job_id} onClick={() => act(r.job_id, 'approve')}
                  className="flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white">
                  <Check className="w-3.5 h-3.5" /> Approve
                </button>
                <button disabled={busyId === r.job_id} onClick={() => act(r.job_id, 'decline')}
                  className="flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-bg-2 border border-hairline hover:bg-hairline text-ink-2">
                  <X className="w-3.5 h-3.5" /> Decline
                </button>
              </div>
            ) : (
              <button onClick={() => navigate(`/jobs/${r.job_id}`)}
                className="flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-bg-2 border border-hairline hover:bg-hairline text-ink-2">
                Open <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
