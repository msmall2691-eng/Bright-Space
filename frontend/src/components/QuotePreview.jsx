/**
 * QuotePreview — the editor's live preview. Renders the EXACT public-page
 * component (QuoteDocument), not an approximation: what gets approved here is
 * what the customer opens. Maps the in-progress editor form to the public
 * serialization shape and mocks the action buttons (disabled) so the layout
 * matches the real page.
 */
import QuoteDocument from './QuoteDocument'

export default function QuotePreview({ form, quoteNumber, company = {} }) {
  const items = (form.items || []).filter(i => (i.name || '').trim() || parseFloat(i.unit_price) > 0)
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
  const rate = parseFloat(form.tax_rate) || 0
  const tax = subtotal * rate / 100
  // Match the public page's "June 30, 2026" date format, parsing parts
  // explicitly so the day isn't shifted by UTC-midnight interpretation.
  const fmtDate = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '')
    if (!m) return d || null
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  }

  const quote = {
    quote_number: quoteNumber || 'QT-…',
    quote_date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    title: form.title || '',
    customer_message: form.customer_message || '',
    company_name: company.company_name || 'Maine Cleaning Co',
    company_email: company.company_email || null,
    company_phone: company.company_phone || null,
    terms: company.quote_terms || null,
    brand_color: company.brand_color || '#1f2937',
    address: form.address || '',
    service_type: form.service_type || '',
    notes: form.notes || '',
    items,
    subtotal,
    tax_rate: rate,
    tax,
    total: subtotal + tax,
    valid_until: fmtDate(form.valid_until),
  }

  const mockActions = (
    <div className="space-y-2 pt-2 opacity-60 pointer-events-none select-none">
      <div className="w-full bg-emerald-600 text-white font-semibold py-3 text-base rounded-xl text-center">Accept Quote</div>
      <div className="w-full bg-panel border border-hairline text-ink-2 font-medium py-3 text-base rounded-xl text-center">Request changes</div>
      <div className="w-full text-ink-3 font-medium py-1 text-sm text-center">Decline quote</div>
    </div>
  )

  return <QuoteDocument quote={quote} actions={mockActions} />
}
