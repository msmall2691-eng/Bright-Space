import { Send, Copy, Check, Calendar, MapPin, Trash2, Eye } from 'lucide-react'
import InlineSelect from '../InlineSelect'
import { QUOTE_STATUS_DOTS, QUOTE_STATUS_OPTIONS, QUOTE_NEXT_STEP } from './constants'

// "Opened Jul 18, 2:14 PM" read-receipt from the customer's first view of the
// public quote link. viewed_at is recorded server-side and already on the quote
// payload — this just surfaces it.
function fmtViewed(ts) {
  const d = new Date(ts)
  if (isNaN(d)) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const date = sameDay ? 'today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${date}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** A single row in the Quotes tab. Pure props-in — the parent owns the
 *  selection set, current-quote-id (for the "Copied" flash), and every
 *  mutation callback. */
export default function QuoteRow({
  q,
  canEdit,
  clientName,
  selectedIds,
  onToggleSelect,
  onOpenQuote,
  onNavigate,
  onSend,
  onCopyLink,
  onSchedule,
  onArchive,
  onUpdateStatus,
  copiedQuoteId,
}) {
  return (
    <div className="p-3 hover:bg-bg-2/40 transition-colors">
      {/* Stack info + actions on mobile so the button row can wrap instead of
          overflowing off-screen (Archive was getting cut off on iPhone). */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
      <div className="flex items-start sm:items-center gap-3 min-w-0">
        {canEdit && (
          <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => onToggleSelect(q.id)}
            className="w-4 h-4 mt-1 sm:mt-0 shrink-0 rounded border-hairline accent-blue-600 cursor-pointer"
            title="Select for bulk action" />
        )}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenQuote(q)}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{clientName(q.client_id)}</span>
            <span className="text-xs text-ink-3">{q.quote_number}</span>
            {canEdit && ['draft', 'sent', 'viewed', 'accepted', 'declined'].includes(q.status) ? (
              <span onClick={e => e.stopPropagation()}>
                <InlineSelect value={q.status} options={QUOTE_STATUS_OPTIONS}
                  onSelect={(s) => onUpdateStatus(q.id, s)} />
              </span>
            ) : (
              <span className="inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium capitalize leading-none text-ink-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${QUOTE_STATUS_DOTS[q.status] || QUOTE_STATUS_DOTS.draft}`} aria-hidden="true" />
                {(q.status || '').replace(/_/g, ' ')}
              </span>
            )}
            {q.status === 'changes_requested' && <span className="w-2 h-2 rounded-full bg-amber-500" title="Customer requested changes" />}
            {q.last_send_error && ['draft', 'sent', 'viewed'].includes(q.status) && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-300"
                title={q.last_send_error}>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
                send failed
              </span>
            )}
            {q.viewed_at && q.status !== 'converted' && (
              <span className="flex items-center gap-1 text-xs text-ink-3"
                title={`Customer opened this quote on ${new Date(q.viewed_at).toLocaleString()}`}>
                <Eye className="w-3 h-3 shrink-0" /> Opened {fmtViewed(q.viewed_at)}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 mt-0.5">
            {q.address && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5 shrink-0" />{q.address}</span>}
            <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5 shrink-0" />{new Date(q.created_at).toLocaleDateString()}</span>
            <span>{[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), `${q.items?.length || 0} items`].filter(Boolean).join(' · ')}</span>
          </div>
          {QUOTE_NEXT_STEP[q.status] && (
            <div className={`text-[11px] font-medium mt-1 ${QUOTE_NEXT_STEP[q.status].cls}`}>
              {QUOTE_NEXT_STEP[q.status].text}
            </div>
          )}
        </div>
        <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
      </div>
        <div className="flex flex-wrap gap-1.5 sm:flex-nowrap sm:shrink-0">
          <button onClick={() => onNavigate(`/quotes/${q.id}`)}
            className="text-xs px-2.5 py-1.5 bg-bg-2 text-ink-2 hover:bg-bg-3 rounded-lg transition-colors"
            title="Open full page">
            Open
          </button>
          {canEdit && ['draft', 'sent', 'changes_requested'].includes(q.status) && (
            <button onClick={() => onSend(q)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink rounded-lg transition-colors">
              <Send className="w-3 h-3" /> {q.status === 'changes_requested' ? 'Send revised' : q.status === 'draft' ? 'Send' : 'Resend'}
            </button>
          )}
          {canEdit && q.status === 'sent' && (
            <button onClick={() => onCopyLink(q)}
              className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${copiedQuoteId === q.id ? 'border-hairline-2 bg-panel text-emerald-600 dark:text-emerald-300' : 'border-transparent bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink'}`}>
              {copiedQuoteId === q.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedQuoteId === q.id ? 'Copied' : 'Copy Link'}
            </button>
          )}
          {/* Accept / Decline removed — the inline status dropdown next
              to the client name already sets those states (most quotes
              are accepted by the customer via their link anyway). */}
          {canEdit && q.status === 'accepted' && (
            <button onClick={() => onSchedule(q)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-panel border border-hairline-2 text-indigo-700 dark:text-indigo-300 hover:bg-bg-2 font-medium rounded-lg transition-colors">
              <Calendar className="w-3 h-3" />
              Set up schedule
            </button>
          )}
          {q.status === 'converted' && (
            <span className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 text-ink-3"
              title="This quote has been scheduled">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
              <Calendar className="w-3 h-3" />
              Scheduled
            </span>
          )}
          {canEdit && q.status !== 'converted' && (
            <button onClick={() => onArchive(q)}
              title="Archive (hide) this quote"
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 text-ink-3 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
              <Trash2 className="w-3 h-3" />
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
