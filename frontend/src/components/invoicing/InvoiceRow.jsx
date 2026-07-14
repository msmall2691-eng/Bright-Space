import { AlertTriangle, Calendar, CheckCircle, ChevronRight, Send } from 'lucide-react'
import { STATUS, avatar, daysOverdue } from './constants'

/** One row in the Invoicing list — client avatar + invoice number,
 *  amount, due date (with "Nd overdue" chip when applicable), status
 *  dot + label, and the hover-revealed action buttons: Open (full
 *  page), Send, Mark overdue, Mark paid. Row click opens the edit
 *  slide-over; action buttons stop propagation so they don't also
 *  fire the row click.
 *
 *  Fully controlled — parent owns the invoices list, selection,
 *  handlers and clientName lookup. */
export function InvoiceRow({
  inv,
  isSelected,
  isLast,
  clientName,
  openEdit,
  openSend,
  markPaid,
  markOverdue,
  navigate,
}) {
  const st = STATUS[inv.status] || STATUS.draft
  const av = avatar(clientName(inv.client_id))
  const days = daysOverdue(inv)

  return (
    <div
      className={`group flex flex-wrap sm:grid sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 sm:gap-4 items-center px-4 py-3.5 cursor-pointer
        hover:bg-bg transition-colors
        ${!isLast ? 'border-b border-hairline' : ''}
        ${isSelected ? 'bg-bg' : ''}`}
      onClick={() => openEdit(inv)}>

      {/* Client */}
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0 ${av.color}`}>
          {av.initials}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-ink truncate">{clientName(inv.client_id)}</div>
          <div className="text-[11px] text-ink-3">{inv.invoice_number}</div>
        </div>
      </div>

      {/* Amount */}
      <div className="text-sm font-medium text-ink">${inv.total?.toFixed(2)}</div>

      {/* Due date */}
      <div>
        {days ? (
          <span className="flex items-center gap-1 text-[11px] text-red-400">
            <AlertTriangle className="w-3 h-3" />{days}d overdue
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-ink-3">
            <Calendar className="w-3.5 h-3.5" />{inv.due_date || '—'}
          </span>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
        <span className={`text-xs ${st.text}`}>{st.label}</span>
      </div>

      {/* Row actions — hover-reveal on desktop, always visible on touch
          so Send / Mark paid / Mark overdue are reachable on phones. */}
      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
        onClick={e => e.stopPropagation()}>
        <button onClick={() => navigate(`/invoices/${inv.id}`)}
          className="text-[11px] px-2 py-1 rounded-md bg-bg text-ink-3 hover:bg-bg-2 transition-colors"
          title="Open full page">
          Open
        </button>
        {inv.status !== 'paid' && (
          <button onClick={() => openSend(inv)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-bg text-ink-3 hover:bg-bg-2 transition-colors">
            <Send className="w-3 h-3" /> Send
          </button>
        )}
        {inv.status !== 'paid' && inv.status !== 'overdue' && days && (
          <button onClick={() => markOverdue(inv.id)}
            className="text-[11px] px-2 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
            Mark overdue
          </button>
        )}
        {inv.status !== 'paid' && (
          <button onClick={() => markPaid(inv.id)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            <CheckCircle className="w-3 h-3" /> Paid
          </button>
        )}
        <ChevronRight className="w-3.5 h-3.5 text-ink-3 ml-1" />
      </div>
    </div>
  )
}
