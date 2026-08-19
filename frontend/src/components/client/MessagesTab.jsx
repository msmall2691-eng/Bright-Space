import { useEffect, useState } from 'react'
import { Mail, MessageSquare, Send } from 'lucide-react'

/** A single linked email (from the unified comms tables), styled as a chat
 *  bubble — same shape/radius/alignment as an SMS bubble, with the subject
 *  line as a small header inside it. Previously emails rendered as a
 *  separate bordered "card" shape, so an interleaved SMS+email feed looked
 *  like two different UIs glued together (owner: "a little more cleaned
 *  up"). The subject + Mail icon are the only things that still say "this
 *  one's an email." */
function EmailBubble({ em }) {
  const outbound = em.direction === 'outbound'
  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
        outbound ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-bg-2 text-ink-2 rounded-bl-sm'
      }`}>
        <div className={`flex items-center gap-1.5 text-[11px] font-medium mb-1 ${outbound ? 'text-sky-100' : 'text-ink-3'}`}>
          <Mail className="w-3 h-3 shrink-0" />
          <span className="truncate">{em.subject || '(no subject)'}</span>
        </div>
        {em.body && <div className="whitespace-pre-wrap line-clamp-4">{em.body}</div>}
        <div className={`text-xs mt-1 ${outbound ? 'text-sky-200' : 'text-ink-3'}`}>
          {em.created_at ? new Date(em.created_at).toLocaleString() : ''}
        </div>
      </div>
    </div>
  )
}

function SmsBubble({ m }) {
  const outbound = m.direction === 'outbound'
  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
        outbound ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-bg-2 text-ink-2 rounded-bl-sm'
      }`}>
        <div>{m.body}</div>
        <div className={`text-xs mt-1 ${outbound ? 'text-sky-200' : 'text-ink-3'}`}>
          {new Date(m.created_at).toLocaleString()}
        </div>
      </div>
    </div>
  )
}

/** Single compose bar anchored below the feed (chat convention: read the
 *  history above, reply at the bottom — mirrors Comms.jsx's ComposeBar).
 *  Replaces the old pair of always-visible SMS + Email cards that used to
 *  stack above the conversation on the "All" filter, pushing the actual
 *  messages out of view. Targets whichever channel the filter tabs (or a
 *  "Text"/"Email" quick action) point at; a small toggle appears only when
 *  the client has both a phone and an email and the filter is "All", so
 *  there's still exactly one place to pick a channel, not two forms. */
function ComposeBar({
  client, commsFilter,
  smsText, setSmsText, sendSms, sending,
  emailSubject, setEmailSubject, emailBody, setEmailBody, sendEmail, sendingEmail,
}) {
  const hasPhone = !!client.phone
  const hasEmail = !!client.email
  const [channel, setChannel] = useState(() => (
    commsFilter === 'email' ? 'email' : commsFilter === 'sms' ? 'sms' : (hasPhone ? 'sms' : 'email')
  ))
  // A "Text"/"Email" quick action (or the filter tabs) sets commsFilter to a
  // specific channel — follow it so the compose bar always matches what's
  // on screen.
  useEffect(() => {
    if (commsFilter === 'sms' || commsFilter === 'email') setChannel(commsFilter)
  }, [commsFilter])

  if (!hasPhone && !hasEmail) {
    return (
      <div id="message-compose" className="flex items-center gap-2 px-3 py-2 rounded-lg border border-hairline bg-panel text-[12.5px]">
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden="true" />
        <span className="text-ink-2">Add a phone number or email to this client to send a message.</span>
      </div>
    )
  }

  const showToggle = hasPhone && hasEmail && commsFilter === 'all'

  return (
    <div id="message-compose" className="bg-panel border border-hairline rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {channel === 'sms'
            ? <MessageSquare className="w-4 h-4 text-purple-400" />
            : <Mail className="w-4 h-4 text-blue-400" />}
          <span className="text-sm font-medium text-ink">
            {channel === 'sms' ? `Text ${client.phone}` : `Email ${client.email}`}
          </span>
        </div>
        {showToggle && (
          <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-0.5">
            <button onClick={() => setChannel('sms')}
              aria-pressed={channel === 'sms'}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                channel === 'sms' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              SMS
            </button>
            <button onClick={() => setChannel('email')}
              aria-pressed={channel === 'email'}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                channel === 'email' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              Email
            </button>
          </div>
        )}
      </div>

      {channel === 'sms' ? (
        hasPhone ? (
          <div className="flex gap-2">
            <input value={smsText} onChange={e => setSmsText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendSms()}
              placeholder="Type a message..."
              className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-hairline" />
            <button onClick={sendSms} disabled={sending || !smsText.trim()}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm transition-colors">
              <Send className="w-3.5 h-3.5" />{sending ? '...' : 'Send'}
            </button>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">No phone number on file for this client.</p>
        )
      ) : (
        hasEmail ? (
          <div className="space-y-2">
            <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)}
              placeholder="Subject"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-hairline" />
            <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)}
              placeholder="Write a message..."
              rows={3}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-hairline resize-none" />
            <div className="flex justify-end">
              <button onClick={sendEmail} disabled={sendingEmail || !emailBody.trim()}
                className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm transition-colors">
                <Send className="w-3.5 h-3.5" />{sendingEmail ? '...' : 'Send'}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">No email on file for this client.</p>
        )
      )}
    </div>
  )
}

export default function MessagesTab({
  client, messages, emails,
  commsFilter, setCommsFilter,
  smsText, setSmsText, sendSms, sending,
  emailSubject, setEmailSubject, emailBody, setEmailBody, sendEmail, sendingEmail,
}) {
  let items = commsFilter === 'sms' ? messages
            : commsFilter === 'email' ? emails
            : [...messages, ...emails]
  // SMS-only reads as a chat (oldest→newest); everything else newest-first.
  items = [...items].sort((a, b) =>
    commsFilter === 'sms'
      ? new Date(a.created_at) - new Date(b.created_at)
      : new Date(b.created_at) - new Date(a.created_at)
  )

  return (
    <div className="max-w-2xl">
      {/* Channel filter — all aspects linked by email/phone, in one place. */}
      <div className="flex items-center gap-2 mb-4">
        {/* Quiet filter tabs — label + plain count, active is ink + underline
            (owner vetoed the filled chip bubbles). */}
        {[
          { value: 'all',   label: 'All',   count: messages.length + emails.length },
          { value: 'sms',   label: 'SMS',   count: messages.length },
          { value: 'email', label: 'Email', count: emails.length },
        ].map(f => (
          <button key={f.value} onClick={() => setCommsFilter(f.value)}
            aria-pressed={commsFilter === f.value}
            className={`px-0.5 py-1 text-xs font-medium border-b-2 transition-colors ${
              commsFilter === f.value
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}>
            {f.label} <span className="ml-1 text-[10px] tabular-nums text-ink-3">{f.count}</span>
          </button>
        ))}
      </div>

      {/* Conversation feed — read top to bottom like a chat, reply below it.
          SMS and email now share one bubble shape so a mixed "All" feed
          reads as one conversation instead of two different UIs. */}
      {items.length === 0 ? (
        <p className="text-ink-3 text-sm text-center py-8">
          No {commsFilter === 'all' ? 'messages' : commsFilter === 'sms' ? 'SMS' : 'emails'} linked to this client yet
        </p>
      ) : (
        <div className="space-y-2 mb-4">
          {items.map(m => m.channel === 'email'
            ? <EmailBubble key={`e${m.id}`} em={m} />
            : <SmsBubble key={`s${m.id}`} m={m} />
          )}
        </div>
      )}

      <ComposeBar
        client={client} commsFilter={commsFilter}
        smsText={smsText} setSmsText={setSmsText} sendSms={sendSms} sending={sending}
        emailSubject={emailSubject} setEmailSubject={setEmailSubject}
        emailBody={emailBody} setEmailBody={setEmailBody}
        sendEmail={sendEmail} sendingEmail={sendingEmail}
      />
    </div>
  )
}
