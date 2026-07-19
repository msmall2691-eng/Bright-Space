import {
  Calendar, FileText, Receipt, MessageSquare, TrendingUp, Mail, Zap, X,
} from 'lucide-react'
import { JOB_COLORS, INVOICE_COLORS, QUOTE_COLORS, OPP_COLORS } from './constants'

// Filter chips: All / Email / Calendar / Money / Notes
const ACTIVITY_FILTERS = [
  { value: 'all',      label: 'All' },
  { value: 'email',    label: 'Emails',   match: i => i.type === 'email' || i.type === 'message' || (i.type === 'activity_log' && i.data.activity_type?.startsWith('email_')) },
  { value: 'calendar', label: 'Calendar', match: i => i.type === 'job' || i.type === 'gcal_event' || (i.type === 'activity_log' && (i.data.activity_type?.startsWith('job_') || i.data.extra_data?.source === 'gcal')) },
  { value: 'money',    label: 'Money',    match: i => i.type === 'quote' || i.type === 'invoice' || i.type === 'opportunity' },
  { value: 'notes',    label: 'Notes',    match: i => i.type === 'activity_log' && (i.data.activity_type === 'note_added' || !i.data.activity_type?.match(/^(email|job|sms)_/)) },
]

export default function ActivityTimeline({
  allActivity, activityFilter, setActivityFilter,
  noteText, setNoteText, savingNote, submitNote,
}) {
  const activeFilter = ACTIVITY_FILTERS.find(f => f.value === activityFilter)
  const activity = activityFilter === 'all' || !activeFilter?.match
    ? allActivity
    : allActivity.filter(activeFilter.match)

  return (
    <div className="max-w-2xl space-y-3">
      {/* Jot an internal note — lands in this timeline (no conversation needed). */}
      <div className="bg-panel border border-hairline rounded-xl p-3">
        <textarea
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitNote() }}
          rows={2}
          placeholder="Add an internal note about this client…"
          className="w-full resize-none bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] text-ink-3">⌘/Ctrl + Enter</span>
          <button
            onClick={submitNote}
            disabled={savingNote || !noteText.trim()}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50"
          >
            {savingNote ? 'Adding…' : 'Add note'}
          </button>
        </div>
      </div>
      {/* Twenty-style filter chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mt-1 sticky top-0 bg-bg z-10 py-2">
        {ACTIVITY_FILTERS.map(f => {
          const count = f.value === 'all' ? allActivity.length : (f.match ? allActivity.filter(f.match).length : 0)
          const isActive = activityFilter === f.value
          return (
            <button
              key={f.value}
              onClick={() => setActivityFilter(f.value)}
              className={`text-xs px-2.5 py-1 rounded-full border font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-panel border-hairline text-ink-3 hover:bg-bg'
              }`}
            >
              {f.label}
              <span className={`ml-1.5 text-[10px] opacity-70 ${isActive ? 'text-white' : 'text-ink-3'}`}>{count}</span>
            </button>
          )
        })}
      </div>
      {activity.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No {activityFilter === 'all' ? '' : activityFilter} activity yet</p>}
      {activity.map((item, i) => (
        <div key={i} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              item.type === 'job'          ? 'bg-blue-500/10' :
              item.type === 'gcal_event'   ? 'bg-indigo-50' :
              item.type === 'quote'        ? 'bg-indigo-600/20' :
              item.type === 'invoice'      ? 'bg-green-50' :
              item.type === 'opportunity'  ? 'bg-amber-50' :
              item.type === 'email'        ? 'bg-cyan-50' :
              item.type === 'activity_log' ? 'bg-bg-2' :
                                             'bg-purple-50'
            }`}>
              {item.type === 'job'          && <Calendar className="w-3.5 h-3.5 text-blue-500" />}
              {item.type === 'gcal_event'   && <Calendar className="w-3.5 h-3.5 text-indigo-500" />}
              {item.type === 'quote'        && <FileText className="w-3.5 h-3.5 text-blue-400" />}
              {item.type === 'invoice'      && <Receipt className="w-3.5 h-3.5 text-green-400" />}
              {item.type === 'message'      && <MessageSquare className="w-3.5 h-3.5 text-purple-400" />}
              {item.type === 'opportunity'  && <TrendingUp className="w-3.5 h-3.5 text-amber-500" />}
              {item.type === 'email'        && <Mail className="w-3.5 h-3.5 text-cyan-500" />}
              {item.type === 'activity_log' && (
                item.data.extra_data?.source === 'gcal' ? <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                : item.data.extra_data?.single_occurrence ? <X className="w-3.5 h-3.5 text-rose-500" />
                : item.data.activity_type?.startsWith('email_') ? <Mail className="w-3.5 h-3.5 text-cyan-500" />
                : <Zap className="w-3.5 h-3.5 text-ink-3" />
              )}
            </div>
            {i < activity.length - 1 && <div className="w-px flex-1 bg-bg-2 mt-1" />}
          </div>
          <div className="flex-1 pb-4 min-w-0">
            <div className="bg-panel border border-hairline rounded-xl p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {item.type === 'job' && (
                    <>
                      <div className="text-sm font-medium text-ink">{item.data.title}</div>
                      <div className="text-xs text-ink-3 mt-0.5">{item.data.scheduled_date} · {item.data.start_time}–{item.data.end_time}</div>
                    </>
                  )}
                  {item.type === 'gcal_event' && (
                    <>
                      <div className="text-sm font-medium text-ink">{item.data.title}</div>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {item.data.start ? new Date(item.data.start).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                        {item.data.location ? ` · ${item.data.location}` : ''}
                      </div>
                    </>
                  )}
                  {item.type === 'quote' && (
                    <>
                      <div className="text-sm font-medium text-ink">Quote — ${item.data.total?.toFixed(2)}</div>
                      <div className="text-xs text-ink-3 mt-0.5">{item.data.items?.length || 0} items</div>
                    </>
                  )}
                  {item.type === 'invoice' && (
                    <>
                      <div className="text-sm font-medium text-ink">{item.data.invoice_number} — ${item.data.total?.toFixed(2)}</div>
                      <div className="text-xs text-ink-3 mt-0.5">Due {item.data.due_date || 'N/A'}</div>
                    </>
                  )}
                  {item.type === 'message' && (
                    <>
                      <div className="text-sm text-ink-3">{item.data.body}</div>
                      <div className="text-xs text-ink-3 mt-0.5">{item.data.direction} · {item.data.channel}</div>
                    </>
                  )}
                  {item.type === 'opportunity' && (
                    <>
                      <div className="text-sm font-medium text-ink">{item.data.title}</div>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {item.data.amount != null && <span className="text-emerald-600 font-medium">${item.data.amount.toLocaleString()}</span>}
                        {item.data.service_type && <span className="ml-2">{item.data.service_type.replace('_', ' ')}</span>}
                      </div>
                    </>
                  )}
                  {item.type === 'email' && (
                    <>
                      <div className="text-sm font-medium text-ink">{item.data.subject || '(no subject)'}</div>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {item.data.direction === 'outbound' ? `to ${item.data.to_addr || ''}` : `from ${item.data.from_addr || ''}`}
                      </div>
                      {item.data.body && <div className="text-xs text-ink-3 mt-1 truncate">{item.data.body.slice(0, 120)}</div>}
                    </>
                  )}
                  {item.type === 'activity_log' && (
                    <>
                      <div className="text-sm text-ink-3">{item.data.summary}</div>
                      <div className="text-xs text-ink-3 mt-0.5">{item.data.activity_type.replace(/_/g, ' ')}</div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                    item.type === 'job'          ? JOB_COLORS[item.data.status] :
                    item.type === 'gcal_event'   ? 'bg-indigo-500/20 text-indigo-500' :
                    item.type === 'quote'        ? QUOTE_COLORS[item.data.status] :
                    item.type === 'invoice'      ? INVOICE_COLORS[item.data.status] :
                    item.type === 'opportunity'  ? (OPP_COLORS[item.data.stage] || 'bg-amber-500/20 text-amber-500') :
                    item.type === 'email'        ? 'bg-cyan-500/20 text-cyan-500' :
                    item.type === 'activity_log' ? 'bg-bg-2 text-ink-3' :
                    'bg-purple-500/20 text-purple-400'
                  }`}>
                    {item.type === 'message' ? item.data.direction :
                     item.type === 'gcal_event' ? 'event' :
                     item.type === 'opportunity' ? item.data.stage :
                     item.type === 'email' ? (item.data.direction === 'outbound' ? 'sent' : 'email') :
                     item.type === 'activity_log' ? item.data.activity_type?.split('_')[0] :
                     item.data.status?.replace('_', ' ')}
                  </span>
                  <span className="text-xs text-ink-3">
                    {new Date(item.date).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
