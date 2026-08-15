import { useEffect, useState } from 'react'
import { CalendarCheck, ChevronRight } from 'lucide-react'
import { get } from '../../api'
import { SOFT_CARD } from './constants'

/**
 * CustomerActivity — a quiet, no-action feed of visits customers just
 * confirmed. These are FYI (the customer accepted their scheduled time), so
 * they deliberately live here instead of nagging in "Needs you now". Renders
 * nothing when there's no recent activity, so it never adds empty clutter.
 * Reschedule approvals (which DO need the owner) stay in "Needs you now".
 */
export function CustomerActivity({ navigate }) {
  const [items, setItems] = useState(null)

  useEffect(() => {
    get('/api/jobs/recent-confirmations')
      .then(d => setItems(d?.confirmations || []))
      .catch(() => setItems([]))
  }, [])

  const fmt = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' }) : ''
  const rel = (iso) => {
    if (!iso) return ''
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (mins < 60) return `${Math.max(1, mins)}m ago`
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`
    return `${Math.round(mins / 1440)}d ago`
  }

  // Don't render an empty card — this section only earns space when there's
  // something in it.
  if (!items || items.length === 0) return null

  return (
    <section className={`${SOFT_CARD} overflow-hidden`}>
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-hairline">
        <CalendarCheck className="w-4 h-4 shrink-0 text-ink-3" />
        <h2 className="text-sm font-semibold text-ink">Customers confirmed</h2>
        <span className="text-[11px] font-medium text-ink-3">nothing to do — just so you know</span>
      </div>
      <div className="divide-y divide-hairline">
        {items.map(c => (
          <button key={c.job_id} onClick={() => navigate(`/jobs/${c.job_id}`)}
            className="w-full text-left flex items-center gap-3 px-5 py-2.5 hover:bg-bg active:bg-bg-2 transition-colors">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-ink truncate">
                {c.client_name || c.title || `Job #${c.job_id}`} confirmed
              </div>
              <div className="text-[11px] text-ink-3 truncate">
                {fmt(c.scheduled_date)}{c.start_time ? ` · ${c.start_time.slice(0, 5)}` : ''}
              </div>
            </div>
            <span className="text-[10px] text-ink-3 shrink-0">{rel(c.confirmed_at)}</span>
            <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />
          </button>
        ))}
      </div>
    </section>
  )
}
