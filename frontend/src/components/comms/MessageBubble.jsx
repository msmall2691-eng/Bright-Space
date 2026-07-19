import { Mail, CheckCircle2, AlertTriangle, StickyNote } from 'lucide-react'
import { fullTime } from './utils'
import { htmlToText } from '../../utils/format'

/** Chat bubble in the thread view. Internal notes render as a centered
 *  amber card; regular messages align right (outbound) or left (inbound)
 *  with subject header, body, timestamp, and delivery status icons. */
export function MessageBubble({ m, isFirst, showTime, contactName }) {
  // Internal note
  if (m.is_internal_note) {
    return (
      <div className="flex justify-center my-3">
        <div className="max-w-[85%] bg-amber-50/80 border border-amber-200/60 text-amber-900 text-[13px] px-4 py-2.5 rounded-2xl backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-600 mb-1">
            <StickyNote className="w-3 h-3" />
            Internal note
            {m.author && <span className="font-normal text-amber-500">— {m.author}</span>}
            <span className="ml-auto font-normal text-amber-400">{fullTime(m.created_at)}</span>
          </div>
          <div className="whitespace-pre-wrap break-words leading-relaxed">{htmlToText(m.body)}</div>
        </div>
      </div>
    )
  }

  const outbound = m.direction === 'outbound'

  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'} ${isFirst ? 'mt-3' : 'mt-1'}`}>
      <div className="max-w-[72%] min-w-0">
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
              outbound ? 'border-blue-500/30 text-blue-100' : 'border-hairline text-ink-3'
            }`}>
              {m.channel === 'email' && <Mail className="w-3 h-3 inline mr-1 -mt-0.5" />}
              {m.subject}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{htmlToText(m.body)}</div>
          <div className={`text-[11px] mt-1.5 flex items-center gap-1 font-medium ${outbound ? 'text-blue-100 justify-end' : 'text-ink-2'}`}>
            {fullTime(m.created_at)}
            {outbound && m.status === 'delivered' && <CheckCircle2 className="w-3 h-3" />}
            {outbound && m.status === 'failed' && <AlertTriangle className="w-3 h-3 text-red-300" />}
            {m.channel === 'email' && <Mail className="w-3 h-3 ml-1 opacity-50" />}
          </div>
        </div>
      </div>
    </div>
  )
}
