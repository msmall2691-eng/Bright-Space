import { Send, Copy, Check, Calendar, Trash2 } from 'lucide-react'
import InlineSelect from '../InlineSelect'
import { QUOTE_STATUS_COLORS, QUOTE_STATUS_OPTIONS, QUOTE_NEXT_STEP } from './constants'

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
      <div className="flex items-center gap-3">
        {canEdit && (
          <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => onToggleSelect(q.id)}
            className="w-4 h-4 shrink-0 rounded border-hairline accent-blue-600 cursor-pointer"
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
              <span className={`text-xs px-2.5 py-0.5 rounded-full border capitalize ${QUOTE_STATUS_COLORS[q.status] || QUOTE_STATUS_COLORS.draft}`}>{(q.status || '').replace(/_/g, ' ')}</span>
            )}
            {q.status === 'changes_requested' && <span className="w-2 h-2 rounded-full bg-amber-500" title="Customer requested changes" />}
            {q.last_send_error && ['draft', 'sent', 'viewed'].includes(q.status) && (
              <span className="text-xs px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200"
                title={q.last_send_error}>
                send failed
              </span>
            )}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address, `${q.items?.length || 0} items`, new Date(q.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
          </div>
          {QUOTE_NEXT_STEP[q.status] && (
            <div className={`text-[11px] font-medium mt-1 ${QUOTE_NEXT_STEP[q.status].cls}`}>
              {QUOTE_NEXT_STEP[q.status].text}
            </div>
          )}
        </div>
        <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
        <div className="flex gap-1.5 shrink-0">
          <button onClick={() => onNavigate(`/quotes/${q.id}`)}
            className="text-xs px-2.5 py-1.5 bg-bg-2 text-ink-2 hover:bg-bg-3 rounded-lg transition-colors"
            title="Open full page">
            Open
          </button>
          {canEdit && (q.status === 'draft' || q.status === 'sent') && (
            <button onClick={() => onSend(q)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors">
              <Send className="w-3 h-3" /> Send
            </button>
          )}
          {canEdit && q.status === 'sent' && (
            <button onClick={() => onCopyLink(q)}
              className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${copiedQuoteId === q.id ? 'bg-green-600/30 text-green-400' : 'bg-purple-600/20 text-purple-400 hover:bg-purple-600/30'}`}>
              {copiedQuoteId === q.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedQuoteId === q.id ? 'Copied' : 'Copy Link'}
            </button>
          )}
          {/* Accept / Decline removed — the inline status dropdown next
              to the client name already sets those states (most quotes
              are accepted by the customer via their link anyway). */}
          {canEdit && q.status === 'accepted' && (
            <button onClick={() => onSchedule(q)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
              <Calendar className="w-3 h-3" />
              Set up schedule
            </button>
          )}
          {q.status === 'converted' && (
            <span className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-green-50 text-green-500 rounded-lg"
              title="This quote has been scheduled">
              <Calendar className="w-3 h-3" />
              Scheduled ✓
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
