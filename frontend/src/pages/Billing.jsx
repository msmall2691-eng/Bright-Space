/**
 * Billing — one home for the money side of the business.
 *
 * Quoting and Invoicing used to be two separate sidebar destinations; they're
 * the same workflow (price the work → bill for it), so they live here behind a
 * single tab strip. Each tab mounts the existing full page unchanged — this is
 * a thin shell, not a rewrite — so all their logic (filters, saved views,
 * detail drawers) keeps working. The active tab is in the URL (?view=) so links
 * and the back button behave.
 */
import { useSearchParams } from 'react-router-dom'
import { FileText, Receipt } from 'lucide-react'
import Quoting from './Quoting'
import Invoicing from './Invoicing'

const TABS = [
  { key: 'quotes', label: 'Quotes', icon: FileText },
  { key: 'invoices', label: 'Invoices', icon: Receipt },
]

export default function Billing() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'invoices' ? 'invoices' : 'quotes'

  const setView = (v) => {
    const next = new URLSearchParams(params)
    next.set('view', v)
    // The Quotes surface owns ?tab (leads/quotes/follow-ups); drop it when we
    // switch to Invoices so a stale value doesn't ride along.
    if (v === 'invoices') next.delete('tab')
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Billing sub-nav: quotes + invoices under one roof */}
      <div className="flex items-center gap-1 px-4 sm:px-8 border-b border-hairline bg-panel/40 shrink-0">
        {TABS.map(t => {
          const active = view === t.key
          return (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-ink-3 hover:text-ink-2'
              }`}
            >
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1 min-h-0">
        {view === 'invoices' ? <Invoicing /> : <Quoting />}
      </div>
    </div>
  )
}
