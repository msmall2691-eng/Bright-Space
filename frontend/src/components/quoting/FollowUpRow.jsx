import { Send, Clock, MapPin, Calendar, Sparkles } from 'lucide-react'

/** Single row on the Follow-ups tab. Renders the "waiting X hours"
 *  chip + one-click Send follow-up + AI Draft follow-up (lands in the
 *  send panel for review) + Options (opens full send panel). */
export default function FollowUpRow({
  q,
  canEdit,
  clientName,
  nudging,
  onOpenQuote,
  onSendFollowUp,
  onOpenSendPanel,
  onDraftFollowUp,
  drafting,
}) {
  const h = q.hours_waiting || 0
  const waited = h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`
  const reasonLabel = q.follow_up_reason === 'viewed_not_accepted' ? 'Opened, no reply' : 'Not opened yet'
  const reasonDot = q.follow_up_reason === 'viewed_not_accepted' ? 'bg-purple-500' : 'bg-amber-500'
  return (
    <div className="bg-panel border border-hairline rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenQuote(q)}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{clientName(q.client_id)}</span>
            <span className="text-xs text-ink-3">{q.quote_number}</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${reasonDot}`} aria-hidden="true" />
              {reasonLabel}
            </span>
            <span className="flex items-center gap-1 text-xs text-ink-3"><Clock className="w-3.5 h-3.5" />waiting {waited}</span>
            {q.follow_up_sent_at && <span className="text-xs text-ink-3">· nudged before</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 mt-0.5">
            {q.address && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5 shrink-0" />{q.address}</span>}
            {q.sent_at && <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5 shrink-0" />sent {new Date(q.sent_at).toLocaleDateString()}</span>}
            <span>{`${q.items?.length || 0} items`}</span>
          </div>
        </div>
        <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
        {canEdit && (
          <div className="flex gap-1.5 shrink-0">
            <button onClick={() => onSendFollowUp(q)} disabled={nudging === q.id}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg transition-colors">
              <Send className="w-3 h-3" /> {nudging === q.id ? 'Sending…' : 'Send follow-up'}
            </button>
            <button onClick={() => onDraftFollowUp(q)} disabled={drafting}
              title="AI-draft a friendly nudge — lands in the send panel for review"
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-bg-2 hover:bg-hairline disabled:opacity-50 text-ink-2 border border-hairline rounded-lg transition-colors">
              <Sparkles className="w-3 h-3" /> {drafting ? 'Drafting…' : 'Draft follow-up'}
            </button>
            <button onClick={() => onOpenSendPanel(q)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-bg-2 hover:bg-hairline text-ink-2 border border-hairline rounded-lg transition-colors">
              Options
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
