import { useState } from 'react'
import { X, Send, Mail, MessageSquare, Eye, ChevronDown } from 'lucide-react'
import { formatPhoneAsTyping, isValidPhoneUS, phoneDigits } from '../../utils/display'

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
  const [phoneTouched, setPhoneTouched] = useState(false)
  if (!selected) return null

  // Phone validation: SMS / Both require a plausible 10-digit US number.
  // We show inline feedback (and disable Send) instead of the previous
  // behavior — accepting anything, showing "Sending…", and then failing
  // with a generic post-send toast that left a stuck "send failed" tag.
  const smsSelected = sendForm.channel === 'sms' || sendForm.channel === 'both'
  const phoneEmpty = !phoneDigits(sendForm.phone)
  const phoneValid = isValidPhoneUS(sendForm.phone)
  const phoneShowError = smsSelected && phoneTouched && (phoneEmpty || !phoneValid)
  const emailValid = sendForm.channel === 'sms' ? true : !!sendForm.email
  const canSend = !sending && emailValid && (!smsSelected || (phoneValid && !phoneEmpty))

  const previewSMS = () => {
    const q = selected
    const st = (q.service_type || 'residential').charAt(0).toUpperCase() + (q.service_type || 'residential').slice(1)
    return `${companyName} — Quote ${q.quote_number || `QT-${q.id}`}\n${st} clean${q.address ? ` at ${q.address}` : ''}\nTotal: $${parseFloat(q.total || 0).toFixed(2)}${q.valid_until ? `\nValid until: ${q.valid_until}` : ''}\n\nReply YES to accept or ask any questions.`
  }

  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-hairline sm:shrink-0">
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
        {smsSelected && (
          <div>
            <label className="block text-xs text-ink-3 mb-1">Phone Number</label>
            <input
              type="tel"
              inputMode="tel"
              value={sendForm.phone}
              onChange={e => setSendForm(f => ({ ...f, phone: formatPhoneAsTyping(e.target.value) }))}
              onBlur={() => setPhoneTouched(true)}
              placeholder="(207) 555-1234"
              aria-invalid={phoneShowError ? 'true' : undefined}
              className={`w-full bg-panel border rounded-lg px-3 py-2 text-sm focus:outline-none ${
                phoneShowError
                  ? 'border-red-500/60 focus:border-red-500'
                  : 'border-hairline focus:border-blue-400'
              }`}
            />
            {phoneShowError && (
              <p className="text-[11px] text-red-500 mt-1">
                {phoneEmpty
                  ? 'Enter a 10-digit US phone number to send SMS.'
                  : 'Phone number must be 10 digits — check the area code.'}
              </p>
            )}
          </div>
        )}

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
        <button
          onClick={() => { setPhoneTouched(true); if (canSend) onSend() }}
          disabled={!canSend}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
          <Send className="w-4 h-4" />
          {sending ? 'Sending...' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
        </button>
      </div>
    </div>
  )
}
