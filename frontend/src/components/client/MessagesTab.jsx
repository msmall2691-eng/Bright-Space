import { Mail, MessageSquare, Send } from 'lucide-react'

/** A single linked email (from the unified comms tables), Twenty-style. */
function EmailCard({ em }) {
  const outbound = em.direction === 'outbound'
  return (
    <div className="bg-panel border border-hairline rounded-xl p-4 hover:shadow-sm transition-all">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${outbound ? 'bg-blue-100' : 'bg-cyan-100'}`}>
          <Mail className={`w-4 h-4 ${outbound ? 'text-blue-600' : 'text-cyan-600'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm truncate flex-1 font-medium text-ink">{em.subject || '(no subject)'}</span>
            <span className="text-[10px] text-ink-3 shrink-0">
              {em.created_at ? new Date(em.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
            </span>
          </div>
          <div className="text-xs text-ink-3 mt-0.5 flex items-center gap-1.5">
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${outbound ? 'bg-blue-50 text-blue-600' : 'bg-cyan-50 text-cyan-600'}`}>
              {outbound ? 'Sent' : 'Received'}
            </span>
            <span className="truncate">{outbound ? `To: ${em.to_addr || ''}` : (em.from_addr || '')}</span>
          </div>
          {em.body && <p className="text-xs text-ink-3 mt-1.5 line-clamp-2">{em.body}</p>}
        </div>
      </div>
    </div>
  )
}

export default function MessagesTab({
  client, messages, emails,
  commsFilter, setCommsFilter,
  smsText, setSmsText, sendSms, sending,
}) {
  return (
    <div className="max-w-2xl">
      {/* Channel filter — all aspects linked by email/phone, in one place. */}
      <div className="flex items-center gap-2 mb-4">
        {[
          { value: 'all',   label: 'All',   count: messages.length + emails.length },
          { value: 'sms',   label: 'SMS',   count: messages.length },
          { value: 'email', label: 'Email', count: emails.length },
        ].map(f => (
          <button key={f.value} onClick={() => setCommsFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              commsFilter === f.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
            }`}>
            {f.label} <span className={commsFilter === f.value ? 'text-sky-100' : 'text-ink-3'}>{f.count}</span>
          </button>
        ))}
      </div>

      {/* SMS compose (visible on All + SMS) */}
      {commsFilter !== 'email' && (client.phone ? (
        <div className="bg-panel border border-hairline rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-ink">Send SMS to {client.phone}</span>
          </div>
          <div className="flex gap-2">
            <input value={smsText} onChange={e => setSmsText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendSms()}
              placeholder="Type a message..."
              className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-hairline" />
            <button onClick={sendSms} disabled={sending || !smsText.trim()}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm transition-colors">
              <Send className="w-3.5 h-3.5" />{sending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 text-sm rounded-xl p-4 mb-4">
          Add a phone number to this client to enable SMS.
        </div>
      ))}

      {/* Unified message feed. SMS render as chat bubbles, emails as cards. */}
      {(() => {
        let items = commsFilter === 'sms' ? messages
                  : commsFilter === 'email' ? emails
                  : [...messages, ...emails]
        // SMS-only reads as a chat (oldest→newest); everything else newest-first.
        items = [...items].sort((a, b) =>
          commsFilter === 'sms'
            ? new Date(a.created_at) - new Date(b.created_at)
            : new Date(b.created_at) - new Date(a.created_at)
        )
        if (items.length === 0) {
          return <p className="text-ink-3 text-sm text-center py-8">
            No {commsFilter === 'all' ? 'messages' : commsFilter === 'sms' ? 'SMS' : 'emails'} linked to this client yet
          </p>
        }
        return (
          <div className="space-y-2">
            {items.map(m => m.channel === 'email'
              ? <EmailCard key={`e${m.id}`} em={m} />
              : (
                <div key={`s${m.id}`} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
                    m.direction === 'outbound'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-bg-2 text-ink-2 rounded-bl-sm'
                  }`}>
                    <div>{m.body}</div>
                    <div className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-sky-200' : 'text-ink-3'}`}>
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
        )
      })()}
    </div>
  )
}
