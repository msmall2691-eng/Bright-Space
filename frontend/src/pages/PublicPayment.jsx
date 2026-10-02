import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle, AlertCircle, Clock } from 'lucide-react'
import { publicFetch } from '../utils/publicFetch'

/**
 * PublicPayment — the customer's no-login invoice page at /pay/:token.
 *
 * Shows the invoice (number, line items, totals, due date, status) and, when a
 * balance is owed, either a pay button or a "how to pay" panel. The server
 * decides which via `online_payment_enabled` — false when Stripe isn't
 * configured, so an unfinished integration reads as the reply/call path rather
 * than a button that fails after the customer has decided to pay.
 *
 * Paying leaves this page: the button asks the server for a hosted Stripe
 * Checkout URL and redirects to it. No card number ever touches this app, so
 * there is no Stripe.js here and nothing to keep in state.
 *
 * THE RETURN IS A RACE, and `?paid=1` is how it is handled. Stripe sends the
 * customer straight back, which is routinely FASTER than the webhook that
 * marks the invoice paid — and for a bank debit the invoice legitimately stays
 * open for days while the debit clears. So a customer who has just paid can
 * land on an invoice the server still calls unpaid. Trusting the fetched
 * status alone would show them "Total due" and a pay button seconds after they
 * paid, which is how somebody pays twice. When `?paid=1` is present the pay
 * button is suppressed and the page says the payment is in hand but still
 * confirming — true for both rails, and it never claims the invoice is settled
 * when only the customer's browser says so.
 *
 * The token in the URL is the credential; a bad one is a 404 the page renders
 * as "invoice not found", never a redirect to login.
 */
const money = (n) => `$${Number(n || 0).toFixed(2)}`

export default function PublicPayment() {
  const { token } = useParams()
  const [params] = useSearchParams()
  const [inv, setInv] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState(null)

  // Set by Stripe's return URLs. `justPaid` suppresses the pay button even if
  // the fetched invoice still reads unpaid — see the race note above.
  const justPaid = params.get('paid') === '1'
  const justCancelled = params.get('cancelled') === '1'

  const startCheckout = async () => {
    setPaying(true)
    setPayError(null)
    try {
      const res = await publicFetch(`/api/invoices/public/${token}/checkout`, {
        method: 'POST',
      })
      if (!res.ok) {
        // The server's message is written for the customer (409s name the
        // reason: already paid, cancelled, nothing owed), so show it when
        // there is one rather than a generic failure.
        let detail = ''
        try { detail = (await res.json())?.detail || '' } catch { /* non-JSON body */ }
        setPayError(detail || 'Could not start the payment. Please try again, or call us.')
        setPaying(false)
        return
      }
      const { url } = await res.json()
      if (!url) {
        setPayError('Could not start the payment. Please try again, or call us.')
        setPaying(false)
        return
      }
      // Leaving the page — deliberately not clearing `paying`, so the button
      // stays disabled for the moment before the browser navigates. A second
      // click here is a second Stripe session.
      window.location.assign(url)
    } catch {
      setPayError('Connection error. Please check your connection and try again.')
      setPaying(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await publicFetch(`/api/invoices/public/${token}`)
        if (cancelled) return
        if (!res.ok) {
          if (res.status === 404) setError('Invoice not found. The link may be incorrect or expired.')
          else setError('Something went wrong on our end. Please try again in a moment.')
          return
        }
        setInv(await res.json())
      } catch {
        if (!cancelled) setError('Connection error. Please check your connection and try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [token])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-3">
        <Clock className="w-4 h-4 mr-2 animate-spin" /> Loading your invoice…
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-panel border border-hairline rounded-lg p-6 text-center">
          <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-3" />
          <p className="text-ink">{error}</p>
        </div>
      </div>
    )
  }

  const paid = inv.status === 'paid'
  const voided = inv.status === 'void'
  const owes = !paid && !voided
  // Back from Stripe, money taken, invoice not yet flipped by the webhook.
  // The page must not keep saying "Due" at the top while the panel below says
  // we have their payment — a customer who has just paid reading "Total due"
  // reasonably concludes it failed, and the next thing they do is pay again.
  const awaitingConfirmation = justPaid && owes

  return (
    <div className="min-h-screen py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="bg-panel border border-hairline rounded-lg overflow-hidden">
          <div className="px-6 py-5 border-b border-hairline">
            <div className="text-xs uppercase tracking-wide text-ink-3">Invoice</div>
            <div className="text-2xl font-bold text-ink mt-0.5">{inv.invoice_number}</div>
            {inv.client_name && (
              <div className="text-sm text-ink-2 mt-1">For {inv.client_name}</div>
            )}
          </div>

          {/* Status + due */}
          <div className="px-6 py-4 flex items-center justify-between border-b border-hairline">
            <div className="flex items-center gap-2 text-sm">
              {paid ? (
                <><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /><span className="text-ink-2">Paid{inv.paid_at ? ` on ${new Date(inv.paid_at).toLocaleDateString()}` : ''}</span></>
              ) : voided ? (
                <><span className="w-1.5 h-1.5 rounded-full bg-ink-3" /><span className="text-ink-3">Void</span></>
              ) : awaitingConfirmation ? (
                <><span className="w-1.5 h-1.5 rounded-full bg-ink-3" /><span className="text-ink-2">Payment processing</span></>
              ) : inv.status === 'overdue' ? (
                <><span className="w-1.5 h-1.5 rounded-full bg-red-500" /><span className="text-ink-2">Overdue</span></>
              ) : (
                <><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /><span className="text-ink-2">Due</span></>
              )}
            </div>
            {inv.due_date && !paid && !voided && !awaitingConfirmation && (
              <div className="text-sm text-ink-2">Due by <span className="font-medium text-ink">{inv.due_date}</span></div>
            )}
          </div>

          {/* Line items */}
          <div className="px-6 py-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-3 text-xs uppercase tracking-wide">
                  <th className="text-left font-medium pb-2">Description</th>
                  <th className="text-center font-medium pb-2">Qty</th>
                  <th className="text-right font-medium pb-2">Price</th>
                  <th className="text-right font-medium pb-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {(inv.items || []).map((it, i) => (
                  <tr key={i} className="border-t border-hairline">
                    <td className="py-2 text-ink">
                      <div className="font-medium">{it.name}</div>
                      {it.description && <div className="text-xs text-ink-3 mt-0.5">{it.description}</div>}
                    </td>
                    <td className="py-2 text-center text-ink-2">{Number(it.qty || 1)}</td>
                    <td className="py-2 text-right text-ink-2">{money(it.unit_price)}</td>
                    <td className="py-2 text-right font-medium text-ink">{money(Number(it.qty || 1) * Number(it.unit_price || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between text-ink-2"><span>Subtotal</span><span>{money(inv.subtotal)}</span></div>
              {Number(inv.tax) > 0 && (
                <div className="flex justify-between text-ink-2"><span>Tax{inv.tax_rate ? ` (${inv.tax_rate}%)` : ''}</span><span>{money(inv.tax)}</span></div>
              )}
              {Number(inv.discount) > 0 && (
                <div className="flex justify-between text-emerald-600"><span>Discount</span><span>-{money(inv.discount)}</span></div>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-hairline text-ink font-bold text-base">
                <span>{paid ? 'Total paid' : awaitingConfirmation ? 'Total' : 'Total due'}</span><span>{money(inv.total)}</span>
              </div>
            </div>
          </div>

          {inv.notes && (
            <div className="px-6 pb-4">
              <div className="text-xs uppercase tracking-wide text-ink-3 mb-1">Notes</div>
              <div className="text-sm text-ink-2">{inv.notes}</div>
            </div>
          )}
        </div>

        {/* Payment panel */}
        {paid ? (
          <div className="mt-4 bg-panel border border-hairline rounded-lg px-6 py-4 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-500" />
            <span className="text-sm text-ink-2">This invoice is paid in full — thank you!</span>
          </div>
        ) : justPaid ? (
          /* Came back from Stripe but the invoice isn't marked paid yet. The
             payment is real; the confirmation hasn't landed (a card takes
             seconds, a bank transfer days). Say exactly that, and offer no pay
             button — the whole point is that they do not pay again. */
          <div className="mt-4 bg-panel border border-hairline rounded-lg px-6 py-5">
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 text-ink-3 mt-0.5 shrink-0" />
              <div className="text-sm text-ink-2">
                <div className="text-ink font-medium mb-1">Thanks — we've got your payment</div>
                We're just confirming it with our payment provider. Card payments
                usually confirm within a minute; a bank transfer can take a few
                business days to clear. There's nothing more for you to do, and
                you won't be charged twice.
              </div>
            </div>
          </div>
        ) : owes && (
          <div className="mt-4 bg-panel border border-hairline rounded-lg px-6 py-5">
            {inv.online_payment_enabled ? (
              <>
                <button
                  onClick={startCheckout}
                  disabled={paying}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-md py-2.5 text-sm font-semibold disabled:opacity-60"
                >
                  {paying ? 'Opening secure payment…' : `Pay ${money(inv.total)} online`}
                </button>
                {justCancelled && !payError && (
                  <div className="text-xs text-ink-3 mt-3">
                    Payment cancelled — you haven't been charged.
                  </div>
                )}
                {payError && (
                  <div className="flex items-start gap-2 mt-3">
                    <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                    <div className="text-xs text-ink-2">
                      {payError}
                      {inv.company_phone ? <> Call or text us at <span className="text-ink">{inv.company_phone}</span>.</> : ''}
                    </div>
                  </div>
                )}
                <div className="text-[11px] text-ink-3 mt-3">
                  You'll be taken to our payment provider to finish. We never see
                  or store your card details.
                </div>
              </>
            ) : (
              <div className="text-sm text-ink-2">
                <div className="text-ink font-medium mb-1">Ready to pay?</div>
                Reply to your invoice email with any questions
                {inv.company_phone ? <>, or call/text us at <span className="text-ink">{inv.company_phone}</span></> : ''}.
                Online card payment is coming soon.
              </div>
            )}
          </div>
        )}

        <div className="text-center text-xs text-ink-3 mt-6">{inv.company_name}</div>
      </div>
    </div>
  )
}
