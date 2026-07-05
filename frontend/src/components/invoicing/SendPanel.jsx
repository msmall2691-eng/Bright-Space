import { Mail, MessageSquare, Send, Sparkles, X } from 'lucide-react'
import { inp, lbl } from './constants'

const CHANNELS = [
  { val: 'email', icon: Mail,          label: 'Email' },
  { val: 'sms',   icon: MessageSquare, label: 'SMS'   },
  { val: 'both',  icon: Send,          label: 'Both'  },
]

/** "Send invoice" slide-over: pick channel (email / SMS / both),
 *  fill in address / phone as appropriate, optionally add a custom
 *  message (or ask AI to draft one), preview the invoice card, and
 *  fire off the send.
 *
 *  Fully controlled — parent owns `selected` (the invoice), the
 *  sendForm state, the AI-drafting flag, the sending flag and every
 *  handler. clientName is passed in so the preview card doesn't
 *  need to know how to look up clients. */
export function SendPanel({
  selected,
  sendForm, setSendForm,
  drafting, draftReminder,
  sending, sendInvoice,
  closePanel,
  clientName,
}) {
  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[380px] sm:shrink-0 sm:border-l sm:border-hairline">

      <div className="flex items-start justify-between px-6 py-5 border-b border-hairline">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-bg flex items-center justify-center">
              <Send className="w-3 h-3 text-ink-3" />
            </div>
            <span className="text-sm font-semibold text-ink">Send invoice</span>
          </div>
          <p className="text-xs text-ink-3 mt-1 ml-8">
            {selected.invoice_number} · ${selected.total?.toFixed(2)}
          </p>
        </div>
        <button onClick={closePanel}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-3 hover:text-ink-3 hover:bg-bg transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 p-6 space-y-6">

        {/* Channel selector */}
        <div>
          <label className={lbl}>Deliver via</label>
          <div className="grid grid-cols-3 gap-2">
            {CHANNELS.map(opt => (
              <button key={opt.val} onClick={() => setSendForm(f => ({ ...f, channel: opt.val }))}
                className={`flex flex-col items-center gap-2 py-3.5 rounded-xl border text-xs font-medium transition-colors
                  ${sendForm.channel === opt.val
                    ? 'bg-bg-2 border-hairline text-ink'
                    : 'bg-bg border-hairline text-ink-3 hover:border-hairline hover:text-ink-3'}`}>
                <opt.icon className="w-4 h-4" />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {sendForm.channel !== 'sms' && (
          <div>
            <label className={lbl}>Email address</label>
            <input value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
              placeholder="client@email.com"
              className={inp + ' bg-bg'} />
          </div>
        )}

        {sendForm.channel !== 'email' && (
          <div>
            <label className={lbl}>Phone number</label>
            <input value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="+1 (207) 555-0100"
              className={inp + ' bg-bg'} />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={lbl + ' mb-0'}>Message <span className="normal-case text-ink-3 font-normal">(optional)</span></label>
            <button onClick={draftReminder} disabled={drafting}
              className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50 transition-colors">
              <Sparkles className="w-3 h-3" />
              {drafting ? 'Drafting…' : 'Draft reminder'}
            </button>
          </div>
          <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
            rows={4} placeholder="Add a personal note — or let AI draft a payment reminder. Included with the email and SMS."
            className={inp + ' bg-bg resize-none'} />
        </div>

        {/* Preview card */}
        <div className="rounded-xl border border-hairline bg-bg p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-3">Invoice</div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-ink">{selected.invoice_number}</div>
              <div className="text-xs text-ink-3 mt-0.5">{clientName(selected.client_id)}</div>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-ink">${selected.total?.toFixed(2)}</div>
              {selected.due_date && <div className="text-[11px] text-ink-3 mt-0.5">Due {selected.due_date}</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="p-5 border-t border-hairline">
        <button onClick={sendInvoice} disabled={sending}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
          <Send className="w-3.5 h-3.5" />
          {sending ? 'Sending…' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
        </button>
      </div>
    </div>
  )
}
