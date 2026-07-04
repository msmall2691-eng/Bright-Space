import { CheckCircle } from 'lucide-react'

/** Bottom-right success toast for the Quoting page. Pure props-in — the
 *  parent controls when to render it and what to show. */
export default function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-panel border border-hairline text-ink text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}
