/**
 * Billing ("Money") — the billing side of the business: invoices + payments.
 *
 * Quotes used to live here too, behind a quotes/invoices tab strip. They moved
 * to their own route (/quotes) under the Requests hub, so incoming → quote →
 * accepted read as one journey and a quote isn't listed in two places. This is
 * now a thin wrapper around Invoicing; a legacy ?view=quotes link (there were
 * several) redirects to the new home rather than 404-ing or dead-ending.
 */
import { Navigate, useSearchParams } from 'react-router-dom'
import Invoicing from './Invoicing'

export default function Billing() {
  const [params] = useSearchParams()
  // Old links pointed at /billing?view=quotes — send them to the new /quotes.
  if (params.get('view') === 'quotes') return <Navigate to="/quotes" replace />

  return (
    <div className="flex flex-col h-full bg-bg">
      <div className="flex-1 min-h-0">
        <Invoicing />
      </div>
    </div>
  )
}
