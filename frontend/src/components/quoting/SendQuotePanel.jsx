import { useState } from 'react'
import { X, Send, Mail, MessageSquare, Eye, ChevronDown, AlertCircle } from 'lucide-react'

// US-phone helpers. Twilio silently rejects anything that isn't a valid
// E.164 number; catching that upfront (instead of after "Sending…") keeps
// the user from having to guess why the send failed.
function _digitsOnly(v) { return String(v || '').replace(/\D/g, '') }
function _usDigits(v) {
  const d = _digitsOnly(v)
  // Accept both bare 10-digit ("2075551234") and E.164 US ("+12075551234").
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return d
}
// Client records sometimes carry a labelled non-number in the phone field,
// e.g. "+12074518184 (placeholder)". The digits look valid to isValidUsPhone,
// so an explicit label check keeps the send button disabled for them.
function _isPlaceholderPhone(v) { return /\bplaceholder\b|\btbd\b|\bunknown\b/i.test(String(v || '')) }
function isValidUsPhone(v) {
  if (_isPlaceholderPhone(v)) return false
  const d = _usDigits(v)
  if (d.length !== 10) return false
  // NANP: area code and exchange first digits are 2-9. Rejects "0075551234".
  if (d[0] === '0' || d[0] === '1') return false
  if (d[3] === '0' || d[3] === '1') return false
  return true
}
function formatUsPhone(v) {
  const d = _usDigits(v).slice(0, 10)
  if (d.length < 4) return d
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** Right-side (bottom-sheet on mobile) send-quote panel. Delivery via
 *  email, SMS, or both — with subject/greeting/copy-to for email and a
 *  live SMS preview. Owns the `previewOpen` toggle only; the form state
 *  itself is parent-owned so mid-send the parent can wipe / seed it as
 *  quotes change. */
export default function SendQuotePanel({
  selected,
  clientName,
  companyName,
  sendForm,
  setSendForm,
  sending,
  onClose,
  onSend,
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  if (!selected) return null

  const previewSMS = () => {
    const q = selected
    const st = (q.service_type || 'residential').charAt(0).toUpperCase() + (q.service_type || 'residential').slice(1).toLowerCase()
    // Mirror the backend rule: first token of the client's real name, skipped
    // when it's a phone number / placeholder so we don't greet "Hi +12074329492,".
    const rawName = String(clientName(q.client_id) || '')
    const firstToken = rawName.split(/\s+/)[0] || ''
    const isPlaceholder = !firstToken || /[\d+()]/.test(firstToken) || /^client\s*#/i.test(rawName)
    const first = isPlaceholder ? '' : firstToken
    const note = (sendForm.custom_message || '').trim()
    const greeting = note
      ? note
      : first
      ? `Hi ${first}, your quote from ${companyName} is ready.`
      : `Hi there, your quote from ${companyName} is ready.`
    const number = q.quote_number || `QT-${q.id}`
    const lines = [
      greeting,
      `Quote ${number} — ${st} clean${q.address ? ` at ${q.address}` : ''}`,
      `Total: $${parseFloat(q.total || 0).toFixed(2)}`,
    ]
    if (q.valid_until) lines.push(`Valid until: ${q.valid_until}`)
    lines.push('', 'Tap the link to accept, or reply with any questions.')
    return lines.join('\n')
  }

  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col pb-bottomnav sm:pb-0 sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-hairline sm:shrink-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
        <div>
          <h2 className="font-semibold text-ink">Send Quote</h2>
          <p className="text-xs text-ink-3 mt-0.5">{selected.quote_number} · {clientName(selected.client_id)} · ${parseFloat(selected.total || 0).toFixed(2)}</p>
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

        {/* Channel selector */}
        <div>
          <label className="block text-xs text-ink-3 mb-2">Send via</label>
          <div className="flex gap-2">
            {[
              { id: 'email', label: 'Email', icon: Mail },
              { id: 'sms', label: 'SMS', icon: MessageSquare },
              { id: 'both', label: 'Both', icon: Send },
            ].map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setSendForm(f => ({ ...f, channel: id }))}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${sendForm.channel === id ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>
        </div>

        {/* Email address */}
        {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
          <div>
            <label className="block text-xs text-ink-3 mb-1">Email Address</label>
            <input type="email" value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
              placeholder="client@example.com"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>
        )}

        {/* Email envelope — subject + greeting, both editable per send */}
        {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-ink-3 mb-1">Email Subject</label>
              <input value={sendForm.subject} onChange={e => setSendForm(f => ({ ...f, subject: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1">Greeting Name</label>
              <input value={sendForm.greeting} onChange={e => setSendForm(f => ({ ...f, greeting: e.target.value }))}
                placeholder="Leave blank for a plain “Hello,”"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              <p className="text-[11px] text-ink-3 mt-1">The email opens with “Hello {sendForm.greeting.trim() || '…'},”</p>
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1">Send a copy to me</label>
              <input type="email" value={sendForm.copy_to} onChange={e => setSendForm(f => ({ ...f, copy_to: e.target.value }))}
                placeholder="you@yourcompany.com"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              <p className="text-[11px] text-ink-3 mt-1">You'll get a blind copy of the quote email. Leave blank to use your company email.</p>
            </div>
          </div>
        )}

        {/* Phone */}
        {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (() => {
          // Show the invalid-format hint only after the user has typed
          // something — silent while the field is still empty so the initial
          // state doesn't look like an error.
          const phoneRaw = sendForm.phone || ''
          const hasDigits = _digitsOnly(phoneRaw).length > 0
          const phoneOk = isValidUsPhone(phoneRaw)
          return (
            <div>
              <label className="block text-xs text-ink-3 mb-1">Phone Number</label>
              <input type="tel" value={formatUsPhone(phoneRaw)}
                onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="(207) 555-1234"
                inputMode="tel"
                autoComplete="tel-national"
                aria-invalid={hasDigits && !phoneOk}
                className={`w-full bg-panel border rounded-lg px-3 py-2 text-sm focus:outline-none ${
                  hasDigits && !phoneOk
                    ? 'border-red-400 focus:border-red-500'
                    : 'border-hairline focus:border-blue-400'
                }`} />
              {hasDigits && !phoneOk && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-red-500">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  Enter a valid 10-digit US number
                </p>
              )}
            </div>
          )
        })()}

        {/* SMS preview */}
        {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
          <div>
            <button onClick={() => setPreviewOpen(p => !p)}
              className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-3 mb-2">
              <Eye className="w-3.5 h-3.5" /> Preview SMS <ChevronDown className={`w-3 h-3 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
            </button>
            {previewOpen && (
              <div className="bg-bg-2 rounded-lg p-3 text-xs text-ink-3 whitespace-pre-wrap font-mono border border-hairline">
                {previewSMS()}
              </div>
            )}
          </div>
        )}

        {/* Email preview info */}
        {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
          <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-3">
            <div className="text-xs text-blue-300 font-medium mb-1">Email includes:</div>
            <ul className="text-xs text-blue-400 space-y-0.5">
              <li>• Quote title, your message, and all line items with totals</li>
              <li>• Accept / request-changes link to the online quote</li>
              <li>• Valid-until date (only when the quote has one)</li>
              <li>• PDF copy attached</li>
            </ul>
          </div>
        )}

        {/* Custom intro message */}
        <div>
          <label className="block text-xs text-ink-3 mb-1">Personal note (optional)</label>
          <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
            rows={3} placeholder="Hi! Great talking with you — here's the quote we discussed..."
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
          <p className="text-xs text-ink-3 mt-1">Included at the top of the email and prepended to the SMS. If blank, the quote's "Message to Customer" is used.</p>
        </div>

        {/* Quote summary */}
        <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
          <div className="text-xs text-ink-3 mb-2">Quote summary</div>
          {(selected.items || []).map((item, i) => (
            <div key={i} className="flex justify-between text-ink-3">
              <span>{item.name} {parseFloat(item.qty) !== 1 ? `×${item.qty}` : ''}</span>
              <span>${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}</span>
            </div>
          ))}
          <div className="flex justify-between font-bold text-ink border-t border-hairline pt-2 mt-1">
            <span>Total</span><span>${parseFloat(selected.total || 0).toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div className="p-6 border-t border-hairline shrink-0">
        {(() => {
          // Block a send that Twilio would silently reject — either no
          // destination at all, or SMS/both selected with a bad phone.
          const smsSelected = sendForm.channel === 'sms' || sendForm.channel === 'both'
          const smsBlocked = smsSelected && !isValidUsPhone(sendForm.phone)
          const noDestination = !sendForm.email && !sendForm.phone
          // Mirror the backend send guard: never send an empty or $0 quote.
          const emptyQuote = !(selected.items || []).length || parseFloat(selected.total || 0) <= 0
          const blocked = sending || noDestination || smsBlocked || emptyQuote
          const blockedTitle = emptyQuote
            ? 'Add at least one line item and a total over $0 before sending.'
            : smsBlocked ? 'Enter a valid US phone number to send SMS.' : undefined
          return (
            <button onClick={onSend} disabled={blocked}
              title={blockedTitle}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              <Send className="w-4 h-4" />
              {sending ? 'Sending...' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
            </button>
          )
        })()}
      </div>
    </div>
  )
}
