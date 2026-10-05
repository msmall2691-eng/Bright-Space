/**
 * The one way to delete an invoice from the UI.
 *
 * `DELETE /api/invoices/{id}` is a HARD delete: the invoice is removed
 * entirely, and with `?force=true` so is the payment record of a paid one.
 * There is no soft-delete, no trash, and no undo.
 *
 * It had two call sites that disagreed. `InvoiceDetail` gated it behind a
 * danger dialog that spelled out the consequences and escalated to `force`
 * for a paid invoice. The Invoicing list panel
 * (`hooks/useInvoicingMutations.js`) called the same endpoint with **no
 * confirmation at all** — one click on a sent invoice destroyed it, and the
 * customer's copy stopped working, with nothing asked.
 *
 * Copying the dialog into the second call site would have left two copies to
 * drift apart again, which is how they got here. So both now call this.
 *
 * Returns true when the invoice was deleted, false when the operator backed
 * out. Throws whatever the API threw, so each caller still owns its own error
 * presentation (one navigates away, the other refreshes a list).
 */
import { del } from '../api'
import { confirmDialog } from './confirmBus'

export async function confirmAndDeleteInvoice(invoice) {
  if (!invoice?.id) return false
  const paid = invoice.status === 'paid'

  const ok = await confirmDialog(
    `Permanently delete invoice ${invoice.invoice_number || ''}?\n\n` +
    (paid
      ? 'This invoice is PAID — deleting it erases the record of that payment from BrightBase. '
      : '') +
    'The invoice is removed entirely and cannot be recovered. If it was sent to the client, ' +
    'their copy stops working.',
    { title: 'Delete invoice?', confirmLabel: 'Delete permanently', danger: true },
  )
  if (!ok) return false

  // BB-SEC-10: a paid invoice 409s without force. The confirm above already
  // escalated for the paid case the UI knows about, so force is sent ONLY
  // then. A surprise 409 (a status that went stale while the dialog was open)
  // propagates to the caller rather than being silently forced — the operator
  // confirmed deleting what they were shown, not whatever it has become.
  await del(`/api/invoices/${invoice.id}${paid ? '?force=true' : ''}`)
  return true
}
