import { CheckCircle, Send, Sparkles, X } from 'lucide-react'
import { inp } from './constants'

/** Batch "chase overdue" modal — after the owner clicks the amber
 *  "Chase overdue" CTA, this modal opens with an AI-drafted
 *  reminder for each overdue invoice (up to 20). Each card is
 *  independently editable and sendable; the modal never sends
 *  anything automatically. Truncation notice at the bottom when
 *  more than 20 invoices are overdue.
 *
 *  Fully controlled — parent owns the chaser shape ({loading,
 *  truncated, items:[...]}) and the send / edit handlers. */
export function ChaserModal({ chaser, setChaser, sendChaserItem, updateChaserMsg }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setChaser(null)}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Chase overdue invoices</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Review each draft, edit if needed, then send. Nothing is sent automatically.</p>
            </div>
          </div>
          <button onClick={() => setChaser(null)} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
          {chaser.loading ? (
            <div className="py-16 text-center text-[13px] text-ink-3 flex items-center justify-center gap-2">
              <Sparkles className="w-4 h-4 animate-pulse text-amber-500" /> Drafting reminders…
            </div>
          ) : chaser.items.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-ink-3">No overdue invoices to chase.</div>
          ) : chaser.items.map(item => (
            <div key={item.invoice_id} className="rounded-xl border border-hairline bg-bg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">{item.client_name}</div>
                  <div className="text-[11px] text-ink-3">
                    {item.invoice_number} · ${(item.amount || 0).toFixed(2)}
                    {item.days_overdue ? <span className="text-red-600 font-medium"> · {item.days_overdue}d overdue</span> : null}
                    {!item.client_email && <span className="text-amber-600"> · no email, will SMS</span>}
                  </div>
                </div>
                <button onClick={() => sendChaserItem(item)} disabled={item.sending || item.sent}
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium shrink-0 transition-colors ${
                    item.sent ? 'bg-emerald-50 text-emerald-700 cursor-default'
                    : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'}`}>
                  {item.sent ? <><CheckCircle className="w-3.5 h-3.5" /> Sent</>
                    : item.sending ? 'Sending…'
                    : <><Send className="w-3.5 h-3.5" /> Send</>}
                </button>
              </div>
              <textarea value={item.message} onChange={e => updateChaserMsg(item.invoice_id, e.target.value)}
                disabled={item.sent} rows={3}
                className={inp + ' bg-panel resize-none text-[13px]'} />
            </div>
          ))}
          {chaser.truncated && (
            <p className="text-[11px] text-ink-3 text-center pt-1">
              Showing the 20 most overdue. Send these, then reopen to chase the rest.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
