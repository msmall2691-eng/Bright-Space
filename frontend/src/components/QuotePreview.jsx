/**
 * QuotePreview — a live, read-only render of a quote exactly as the customer
 * sees it on the public accept page (PublicQuote.jsx). Driven by the in-progress
 * editor form so the owner can see the client-facing result while drafting
 * (§7.2 #4, "quote reader"). No actions — purely the visual.
 */
export default function QuotePreview({ form, quoteNumber, companyName, clientName }) {
  const items = form.items || []
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
  const rate = parseFloat(form.tax_rate) || 0
  const tax = subtotal * rate / 100
  const total = subtotal + tax
  const money = (n) => `$${(n || 0).toFixed(2)}`
  // Match the public page, which shows the validity date as "June 30, 2026"
  // (the form holds the raw YYYY-MM-DD from the date input). Parse the parts
  // explicitly so it isn't shifted a day by UTC-midnight interpretation.
  const fmtValidUntil = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '')
    if (!m) return d
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="rounded-xl overflow-hidden border border-hairline bg-bg-2/40">
      {/* Customer-facing header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-5">
        <h1 className="text-xl font-bold mb-0.5">Quote {quoteNumber || 'QT-…'}</h1>
        <p className="text-blue-100 text-xs">from {companyName || 'Maine Cleaning Co'}</p>
        {form.valid_until && <p className="text-blue-100 text-[11px] mt-2">Valid until: {fmtValidUntil(form.valid_until)}</p>}
      </div>

      <div className="p-5">
        <div className="bg-panel rounded-lg border border-hairline p-5">
          {form.address && (
            <div className="mb-4 pb-4 border-b border-hairline">
              <p className="text-[10px] text-ink-3 uppercase font-medium mb-1">Service Address</p>
              <p className="text-sm text-ink break-words">{form.address}</p>
            </div>
          )}
          {form.service_type && (
            <div className="mb-4 pb-4 border-b border-hairline">
              <p className="text-[10px] text-ink-3 uppercase font-medium mb-1">Service Type</p>
              <p className="text-sm text-ink capitalize">{form.service_type} cleaning</p>
            </div>
          )}
          {form.notes && (
            <div className="mb-4 pb-4 border-b border-hairline">
              <p className="text-[10px] text-ink-3 uppercase font-medium mb-1.5">Notes</p>
              <p className="text-ink-2 text-xs whitespace-pre-wrap">{form.notes}</p>
            </div>
          )}

          <p className="text-[10px] text-ink-3 uppercase font-medium mb-3">Services</p>
          <div className="space-y-2.5 mb-4">
            {items.length === 0 && <p className="text-xs text-ink-3 italic">No line items yet</p>}
            {items.map((item, i) => (
              <div key={i} className="flex justify-between text-sm gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-ink">{item.name || <span className="text-ink-3 italic">Untitled item</span>}</p>
                  {item.description && <p className="text-[11px] text-ink-3 mt-0.5">{item.description}</p>}
                </div>
                <div className="text-right shrink-0">
                  {parseFloat(item.qty) !== 1 && (
                    <p className="text-[11px] text-ink-3">{item.qty} × {money(parseFloat(item.unit_price || 0))}</p>
                  )}
                  <p className="font-semibold text-ink">{money((parseFloat(item.qty || 1)) * (parseFloat(item.unit_price || 0)))}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5 pt-3 border-t border-hairline">
            <div className="flex justify-between text-sm text-ink-2"><span>Subtotal</span><span>{money(subtotal)}</span></div>
            {tax > 0 && (
              <div className="flex justify-between text-sm text-ink-2"><span>Tax ({rate}%)</span><span>{money(tax)}</span></div>
            )}
            <div className="flex justify-between text-base font-bold text-ink pt-2 border-t border-hairline">
              <span>Total</span><span className="text-emerald-600">{money(total)}</span>
            </div>
          </div>
        </div>

        {/* Customer's action buttons (shown disabled, so the owner sees the full page) */}
        <div className="space-y-2 mt-4 opacity-60 pointer-events-none select-none">
          <div className="w-full bg-emerald-600 text-white font-semibold py-2.5 text-sm rounded-lg text-center">Accept Quote</div>
          <div className="w-full bg-panel border border-hairline text-ink-2 font-medium py-2.5 text-sm rounded-lg text-center">Request changes</div>
        </div>
      </div>
    </div>
  )
}
