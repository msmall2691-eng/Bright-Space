import { CheckCircle, Send, Sparkles } from 'lucide-react'
import Modal from '../ui/Modal'
import { inp } from './constants'

/** Batch "chase overdue" modal — after the owner clicks the amber
 *  "Chase overdue" CTA, this modal opens with an AI-drafted
 *  reminder for each overdue invoice (up to 20). Each card is
 *  independently editable and sendable; the modal never sends
 *  anything automatically. Truncation notice at the bottom when
 *  more than 20 invoices are overdue.
 *
 *  Fully controlled — parent owns the chaser shape ({loading,
 *  truncated, items:[...]}) and the send / edit handlers, and only
 *  mounts this while `chaser` is set, so `open` is always true here.
 *  Built on the shared ui/Modal shell for focus-trap / Esc / scroll-lock. */
export function ChaserModal({ chaser, setChaser, sendChaserItem, updateChaserMsg }) {
  return (
    <Modal
      open
      onClose={() => setChaser(null)}
      maxWidth="2xl"
      ariaLabel="Chase overdue invoices"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Chase overdue invoices</div>
            <div className="text-[12px] font-normal text-ink-3 mt-0.5">Review each draft, edit if needed, then send. Nothing is sent automatically.</div>
          </div>
        </div>
      }
    >
      <Modal.Body className="space-y-3 scrollbar-thin">
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
                  item.sent ? 'bg-panel border border-hairline-2 text-emerald-700 dark:text-emerald-300 cursor-default'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50'}`}>
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
      </Modal.Body>
    </Modal>
  )
}
