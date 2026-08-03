import { useState, useMemo } from 'react'
import { Mail, CheckCircle2, Check, Clock, AlertTriangle, StickyNote, ChevronDown } from 'lucide-react'
import { fullTime } from './utils'
import { htmlToText, splitQuotedEmail } from '../../utils/format'

/** Outbound delivery indicator. Covers the whole lifecycle so a message
 *  that's accepted-but-not-yet-delivered isn't a blank space:
 *  sending → sent → delivered → failed. */
function DeliveryIcon({ status }) {
  const s = (status || '').toLowerCase()
  if (s === 'failed' || s === 'undelivered' || s === 'error')
    return <AlertTriangle className="w-3 h-3 text-red-200" aria-label="failed" />
  if (s === 'delivered' || s === 'read')
    return <CheckCircle2 className="w-3 h-3" aria-label="delivered" />
  if (s === 'sent')
    return <Check className="w-3 h-3" aria-label="sent" />
  // queued / sending / accepted / pending / anything in flight
  return <Clock className="w-3 h-3 opacity-70" aria-label="sending" />
}

/** Chat bubble in the thread view. Internal notes render as a centered
 *  amber card; regular messages align right (outbound) or left (inbound)
 *  with subject header, body, timestamp, and delivery status icons. */
export function MessageBubble({ m, isFirst, showTime, contactName }) {
  // Internal note — flat amber card (no glass/blur), on-token border.
  if (m.is_internal_note) {
    return (
      <div className="flex justify-center my-3">
        <div className="max-w-[85%] bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 text-amber-900 dark:text-amber-200 text-[13px] px-4 py-2.5 rounded-2xl">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300 mb-1">
            <StickyNote className="w-3 h-3" />
            Internal note
            {m.author && <span className="font-normal text-amber-500">— {m.author}</span>}
            <span className="ml-auto font-normal text-amber-500/80">{fullTime(m.created_at)}</span>
          </div>
          <div className="whitespace-pre-wrap break-words leading-relaxed">{htmlToText(m.body)}</div>
        </div>
      </div>
    )
  }

  const outbound = m.direction === 'outbound'
  const [showQuoted, setShowQuoted] = useState(false)

  // Clean the body once per message (not per render): HTML → text, then split
  // off the quoted reply chain / signature. Only email carries quoted history
  // worth collapsing; SMS stays as-is. Memoized so scrolling a long thread
  // doesn't re-run DOMParser + regexes on every bubble.
  const { body, quoted } = useMemo(() => {
    const text = htmlToText(m.body)
    if (m.channel !== 'email') return { body: text, quoted: '' }
    return splitQuotedEmail(text)
  }, [m.body, m.channel])

  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'} ${isFirst ? 'mt-3' : 'mt-1'}`}>
      <div className="max-w-[80%] sm:max-w-[72%] min-w-0">
        {/* Sender label on first message in group */}
        {isFirst && (
          <div className={`text-[10px] font-semibold mb-1 px-1 ${outbound ? 'text-right text-ink-3' : 'text-ink-3'}`}>
            {outbound ? (m.author || 'You') : (contactName || 'Customer')}
          </div>
        )}
        <div className={`px-4 py-2.5 text-[13px] leading-relaxed ${
          outbound
            ? 'bg-indigo-600 text-white rounded-2xl rounded-br-lg shadow-sm'
            : 'bg-panel text-ink rounded-2xl rounded-bl-lg shadow-sm border border-hairline'
        }`}>
          {m.subject && (
            <div className={`text-[11px] font-semibold mb-1 pb-1 border-b ${
              outbound ? 'border-white/25 text-indigo-100' : 'border-hairline text-ink-3'
            }`}>
              {m.channel === 'email' && <Mail className="w-3 h-3 inline mr-1 -mt-0.5" />}
              {m.subject}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{body}</div>
          {/* Quoted reply history / signature — collapsed by default so each
              email shows just the new content. One tap reveals the full chain. */}
          {quoted && (
            <div className="mt-1.5">
              <button onClick={() => setShowQuoted(v => !v)}
                className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-1.5 py-0.5 transition-colors ${
                  outbound ? 'text-indigo-100/90 hover:bg-white/10' : 'text-ink-3 hover:bg-bg-2'
                }`}>
                <ChevronDown className={`w-3 h-3 transition-transform ${showQuoted ? 'rotate-180' : ''}`} />
                {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
              </button>
              {showQuoted && (
                <div className={`mt-1 pl-2 border-l-2 whitespace-pre-wrap break-words text-[12px] ${
                  outbound ? 'border-white/25 text-indigo-100/80' : 'border-hairline text-ink-3'
                }`}>
                  {quoted}
                </div>
              )}
            </div>
          )}
          <div className={`text-[11px] mt-1.5 flex items-center gap-1 font-medium ${outbound ? 'text-indigo-100 justify-end' : 'text-ink-2'}`}>
            {fullTime(m.created_at)}
            {outbound && <DeliveryIcon status={m.status} />}
            {m.channel === 'email' && <Mail className="w-3 h-3 ml-1 opacity-50" />}
          </div>
        </div>
      </div>
    </div>
  )
}
