/**
 * QuoteDocument — THE customer-facing quote, one component rendered by both
 * the public /quote/:token page and the editor's Preview. What Megan approves
 * in the editor is byte-for-byte what the customer sees. Mirrors the email's
 * visual identity (brand-colored header band, itemized table, contact block,
 * terms) so every surface in the funnel matches.
 *
 * `quote` is the public-dict shape from /api/quotes/public/:token. Every
 * optional section collapses entirely when its data is absent — a minimal
 * quote must look intentional, never broken. `actions` is an optional slot
 * (the public page's Accept/Request/Decline block); the preview passes a
 * disabled mock so the layout matches.
 */
const money = (n) => `$${(parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const qtyLabel = (q) => {
  const n = parseFloat(q)
  if (Number.isNaN(n)) return '1'
  return Number.isInteger(n) ? String(n) : String(n)
}

export default function QuoteDocument({ quote, actions = null }) {
  if (!quote) return null
  const items = Array.isArray(quote.items) ? quote.items : []
  const subtotal = parseFloat(quote.subtotal) || 0
  const tax = parseFloat(quote.tax) || 0
  const total = parseFloat(quote.total) || 0
  const brand = quote.brand_color || '#1f2937'
  const hasMeta = !!(quote.address || quote.service_type)

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header band — same identity as the email */}
      <div className="rounded-t-2xl px-6 py-7 sm:px-8 sm:py-8 text-white" style={{ background: brand }}>
        <p className="text-xs font-semibold uppercase tracking-widest text-white/70 mb-2">{quote.company_name || 'Quote'}</p>
        <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
          {quote.title || 'Your Cleaning Quote'}
        </h1>
        <p className="text-sm text-white/70 mt-2">
          {[quote.quote_number, quote.quote_date].filter(Boolean).join(' · ')}
        </p>
        {quote.valid_until && (
          <span className="inline-block mt-3 text-[11px] font-medium bg-white/15 border border-white/20 rounded-full px-3 py-1">
            Valid until {quote.valid_until}
          </span>
        )}
      </div>

      {/* Document body */}
      <div className="bg-panel border border-hairline border-t-0 rounded-b-2xl shadow-sm">
        <div className="px-6 py-6 sm:px-8 sm:py-7">

          {/* Letter opening — the customer message, not a detached gray card */}
          {quote.customer_message && (
            <p className="text-[15px] leading-relaxed text-ink-2 whitespace-pre-wrap mb-6">
              {quote.customer_message}
            </p>
          )}

          {/* Compact meta row: address + service type side by side */}
          {hasMeta && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-bg rounded-xl border border-hairline px-4 py-3.5 mb-6">
              {quote.address && (
                <div>
                  <p className="text-[10px] text-ink-3 uppercase font-semibold tracking-wide mb-0.5">Service Address</p>
                  <p className="text-sm text-ink">{quote.address}</p>
                </div>
              )}
              {quote.service_type && (
                <div>
                  <p className="text-[10px] text-ink-3 uppercase font-semibold tracking-wide mb-0.5">Service Type</p>
                  <p className="text-sm text-ink capitalize">{quote.service_type === 'str' ? 'STR / Vacation rental' : `${quote.service_type} cleaning`}</p>
                </div>
              )}
            </div>
          )}

          {/* Customer-facing scope notes (internal notes NEVER reach this page) */}
          {quote.notes && (
            <div className="mb-6">
              <p className="text-[10px] text-ink-3 uppercase font-semibold tracking-wide mb-1.5">Scope &amp; Details</p>
              <p className="text-sm text-ink-2 whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          {/* Itemized table — same columns as the email */}
          <table className="w-full text-sm mb-1">
            <thead>
              <tr className="text-left text-[10px] text-ink-3 uppercase tracking-wide border-b border-hairline">
                <th className="py-2 font-semibold">Service</th>
                <th className="py-2 font-semibold text-right w-12">Qty</th>
                <th className="py-2 font-semibold text-right w-24">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={3} className="py-4 text-ink-3 italic text-center">No line items</td></tr>
              )}
              {items.map((item, i) => (
                <tr key={i} className="border-b border-hairline/60 align-top">
                  <td className="py-2.5 pr-3">
                    <p className="font-medium text-ink">{item.name || 'Service'}</p>
                    {item.description && <p className="text-xs text-ink-3 mt-0.5">{item.description}</p>}
                  </td>
                  <td className="py-2.5 text-right text-ink-2">{qtyLabel(item.qty ?? 1)}</td>
                  <td className="py-2.5 text-right font-medium text-ink">
                    {money((parseFloat(item.qty ?? 1) || 0) * (parseFloat(item.unit_price) || 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="ml-auto sm:w-64 space-y-1.5 pt-3">
            <div className="flex justify-between text-sm text-ink-2">
              <span>Subtotal</span><span>{money(subtotal)}</span>
            </div>
            {tax > 0 && (
              <div className="flex justify-between text-sm text-ink-2">
                <span>Tax{quote.tax_rate ? ` (${quote.tax_rate}%)` : ''}</span><span>{money(tax)}</span>
              </div>
            )}
            <div className="flex justify-between text-lg font-bold text-ink pt-2 border-t border-hairline">
              <span>Total</span><span style={{ color: brand }}>{money(total)}</span>
            </div>
          </div>
        </div>

        {/* Actions slot — the page's Accept/Request/Decline hierarchy */}
        {actions && (
          <div className="px-6 pb-6 sm:px-8 sm:pb-7">{actions}</div>
        )}

        {/* Trust block: contact + terms */}
        {(quote.company_email || quote.company_phone || quote.terms) && (
          <div className="border-t border-hairline px-6 py-5 sm:px-8 bg-bg rounded-b-2xl">
            {(quote.company_email || quote.company_phone) && (
              <p className="text-sm text-ink-2 text-center mb-1.5">
                Questions?{' '}
                {quote.company_email && (
                  <a href={`mailto:${quote.company_email}`} className="text-blue-600 hover:underline font-medium">{quote.company_email}</a>
                )}
                {quote.company_email && quote.company_phone && <span className="text-ink-3"> · </span>}
                {quote.company_phone && (
                  <a href={`tel:${quote.company_phone}`} className="text-blue-600 hover:underline font-medium">{quote.company_phone}</a>
                )}
              </p>
            )}
            {quote.terms && (
              <div className="mt-3 pt-3 border-t border-hairline/60">
                <p className="text-[10px] text-ink-3 uppercase font-semibold tracking-wide mb-1">Terms &amp; Conditions</p>
                <p className="text-xs text-ink-3 whitespace-pre-wrap leading-relaxed">{quote.terms}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Page footer */}
      <p className="text-center text-[11px] text-ink-3 mt-5 mb-2">
        © {new Date().getFullYear()} {quote.company_name || ''}
      </p>
    </div>
  )
}
