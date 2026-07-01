import { useEffect, useState } from 'react'
import { get } from '../api'
import {
  Mail, MessageSquare, Phone, Calendar, FileText, Receipt, TrendingUp,
  CheckCircle, AlertCircle, Loader, Filter, Users, RefreshCw, XCircle,
} from 'lucide-react'

/**
 * Timeline — one component for both the CRM activity feed and the per-job
 * unified timeline. Renders items normalized to a common shape:
 *
 *   { id, kind, icon_key, label, sub?, actor?, status?, created_at }
 *
 * Pass a `source` object describing how to fetch and filter:
 *
 *   <Timeline source={activitiesSource({ clientId })} />
 *   <Timeline source={activitiesSource({ opportunityId })} />
 *   <Timeline source={jobTimelineSource(jobId)} />
 *
 * Consolidates the earlier ActivityTimeline (activities endpoint) and
 * UnifiedTimeline (job timeline endpoint) — same rendering, day grouping,
 * and filter chips.
 */

// activity_type -> icon
const ACTIVITY_ICONS = {
  email_sent: Mail, email_received: Mail,
  sms_sent: MessageSquare, sms_received: MessageSquare,
  call_logged: Phone,
  job_created: Calendar, job_scheduled: Calendar, job_started: Calendar,
  job_completed: CheckCircle, job_cancelled: XCircle,
  quote_created: FileText, quote_sent: FileText, quote_accepted: CheckCircle,
  invoice_created: Receipt, invoice_sent: Receipt, invoice_paid: CheckCircle,
  opportunity_created: TrendingUp, opportunity_won: CheckCircle, opportunity_lost: AlertCircle,
  status_changed: RefreshCw, note_added: FileText,
}
const ACTIVITY_COLORS = {
  email_sent: 'text-blue-600 bg-blue-50', email_received: 'text-blue-600 bg-blue-50',
  sms_sent: 'text-purple-600 bg-purple-50', sms_received: 'text-purple-600 bg-purple-50',
  call_logged: 'text-green-600 bg-green-50',
  job_created: 'text-yellow-600 bg-yellow-50',
  job_completed: 'text-emerald-600 bg-emerald-50', quote_accepted: 'text-emerald-600 bg-emerald-50',
  invoice_paid: 'text-emerald-600 bg-emerald-50', job_cancelled: 'text-red-600 bg-red-50',
  quote_sent: 'text-orange-600 bg-orange-50', invoice_sent: 'text-cyan-600 bg-cyan-50',
  opportunity_created: 'text-pink-600 bg-pink-50',
  opportunity_won: 'text-emerald-600 bg-emerald-50', opportunity_lost: 'text-red-600 bg-red-50',
  note_added: 'text-ink-2 bg-bg',
}
const PROVIDER_ICONS = { gcal: Calendar, connecteam: Users, email: Mail, sms: MessageSquare }
const CHANNEL_ICONS = { email: Mail, sms: MessageSquare, chat: MessageSquare, whatsapp: MessageSquare }

function visualFor(item) {
  if (item.kind === 'integration') {
    const Icon = PROVIDER_ICONS[item.icon_key] || RefreshCw
    const ok = (item.status || '').toLowerCase() === 'ok'
    return { Icon, bg: ok ? 'bg-emerald-50' : 'bg-red-50', fg: ok ? 'text-emerald-600' : 'text-red-600' }
  }
  if (item.kind === 'message') {
    const Icon = CHANNEL_ICONS[item.icon_key] || MessageSquare
    return { Icon, bg: 'bg-blue-50', fg: 'text-blue-600' }
  }
  const Icon = ACTIVITY_ICONS[item.icon_key] || FileText
  const [fg, bg] = (ACTIVITY_COLORS[item.icon_key] || 'text-ink-2 bg-bg').split(' ')
  return { Icon, bg, fg }
}

function TimelineItem({ item, isLast }) {
  const { Icon, bg, fg } = visualFor(item)
  const date = item.created_at ? new Date(item.created_at) : null
  const timeStr = date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <div className="relative">
      {!isLast && <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-bg-2" />}
      <div className="flex gap-3">
        <div className={`w-10 h-10 rounded-full ${bg} ${fg} flex items-center justify-center flex-shrink-0 mt-0.5 relative z-10`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <div className="flex-1 pb-5 min-w-0">
          <div className="bg-bg rounded-lg p-3 border border-hairline">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-ink text-[13px]">{item.label}</div>
                {item.sub && <div className="text-[12px] text-ink-3 mt-0.5 break-words">{item.sub}</div>}
              </div>
              {item.actor && <div className="text-[11px] text-ink-3 font-medium shrink-0">{item.actor}</div>}
            </div>
            <div className="text-[11px] text-ink-3 mt-1">{timeStr}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function dayLabel(key) {
  if (key === 'Unknown') return 'Undated'
  const d = new Date(key)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (new Date(d.getTime() + 86400000).toDateString() === today.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function Timeline({ source, limit = 50 }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState(source.filters[0]?.value || 'all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    source.fetch(filter, limit)
      .then(list => { if (!cancelled) setItems(list || []) })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key, filter, limit])

  const groups = items.reduce((acc, it) => {
    const key = it.created_at ? new Date(it.created_at).toDateString() : 'Unknown'
    ;(acc[key] = acc[key] || []).push(it)
    return acc
  }, {})
  const dayKeys = Object.keys(groups)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-ink-3 shrink-0" />
        {source.filters.map(f => (
          <button key={f.value} onClick={() => setFilter(f.value)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-medium whitespace-nowrap transition-colors ${
              filter === f.value ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-2 hover:bg-bg-3'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader className="w-5 h-5 animate-spin text-ink-3" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-10">
          <FileText className="w-7 h-7 mx-auto mb-2 opacity-40 text-ink-3" />
          <p className="text-ink-2 text-[13px]">Nothing here yet</p>
        </div>
      ) : (
        <div className="space-y-5">
          {dayKeys.map((key, di) => (
            <div key={key}>
              <div className="text-[11px] font-semibold text-ink-3 mb-3 uppercase tracking-wide">{dayLabel(key)}</div>
              <div>
                {groups[key].map((it, i) => (
                  <TimelineItem key={it.id} item={it}
                    isLast={di === dayKeys.length - 1 && i === groups[key].length - 1} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sources ──────────────────────────────────────────────────────────────

const ACTIVITY_FILTERS = [
  { value: 'all', label: 'All Activities', activity_type: null },
  { value: 'email_sent', label: 'Emails Sent', activity_type: 'email_sent' },
  { value: 'email_received', label: 'Emails Received', activity_type: 'email_received' },
  { value: 'sms_sent', label: 'SMS Sent', activity_type: 'sms_sent' },
  { value: 'quote_sent', label: 'Quotes Sent', activity_type: 'quote_sent' },
  { value: 'invoice_sent', label: 'Invoices Sent', activity_type: 'invoice_sent' },
  { value: 'job_completed', label: 'Jobs Completed', activity_type: 'job_completed' },
  { value: 'opportunity_won', label: 'Opportunities Won', activity_type: 'opportunity_won' },
]

export function activitiesSource({ clientId, opportunityId, jobId } = {}) {
  return {
    key: `activities:${clientId || ''}:${opportunityId || ''}:${jobId || ''}`,
    filters: ACTIVITY_FILTERS,
    async fetch(filter, limit) {
      const params = new URLSearchParams()
      if (clientId) params.append('client_id', clientId)
      if (opportunityId) params.append('opportunity_id', opportunityId)
      if (jobId) params.append('job_id', jobId)
      if (limit) params.append('limit', limit)
      const f = ACTIVITY_FILTERS.find(x => x.value === filter)
      if (f?.activity_type) params.append('activity_type', f.activity_type)
      const data = await get('/api/activities?' + params.toString())
      return (data || []).map(a => ({
        id: a.id,
        kind: 'activity',
        icon_key: a.activity_type,
        label: a.summary,
        sub: (a.activity_type || '').replace(/_/g, ' '),
        actor: a.actor,
        created_at: a.created_at,
      }))
    },
  }
}

const JOB_TIMELINE_FILTERS = [
  { value: 'all', label: 'All', source: null },
  { value: 'activity', label: 'Activity', source: 'activity' },
  { value: 'integration', label: 'Sync', source: 'integration' },
  { value: 'message', label: 'Messages', source: 'message' },
]

export function jobTimelineSource(jobId) {
  return {
    key: `job-timeline:${jobId || ''}`,
    filters: JOB_TIMELINE_FILTERS,
    async fetch(filter, limit) {
      const params = new URLSearchParams({ limit: String(limit) })
      const f = JOB_TIMELINE_FILTERS.find(x => x.value === filter)
      if (f?.source) params.append('source', f.source)
      const d = await get(`/api/jobs/${jobId}/timeline?${params.toString()}`)
      return d?.items || []
    },
  }
}
