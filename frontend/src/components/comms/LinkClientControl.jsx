import { useState, useEffect } from 'react'
import { Link2, Search, Loader2, Check } from 'lucide-react'
import { get } from '../../api'

/**
 * "Link to a client" control for an unknown-sender conversation (client_id NULL).
 * Twenty-style merge-into-contact: search the book of business and attach the
 * whole thread — the missing inbox action the audit flagged. Self-contained:
 * owns its search state and calls onLink(client) with the chosen client.
 */
export function LinkClientControl({ onLink, linking }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ limit: '8' })
      if (q.trim()) params.append('search', q.trim())
      get(`/api/clients?${params.toString()}`)
        .then(d => setResults(Array.isArray(d) ? d : []))
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [open, q])

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={linking}
        className="mt-3 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/15 disabled:opacity-60 py-2 rounded-xl transition-colors">
        {linking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
        Link to a client
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-500/5 p-2 space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-3 pointer-events-none" />
        <input
          autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search clients…"
          className="w-full bg-panel border border-hairline rounded-lg pl-8 pr-2 py-1.5 text-[12px] focus:outline-none focus:border-indigo-400"
        />
      </div>
      <div className="max-h-44 overflow-y-auto rounded-lg border border-hairline divide-y divide-hairline bg-panel">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-ink-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-ink-3 text-center">
            {q.trim() ? 'No matching clients' : 'No clients yet'}
          </div>
        ) : (
          results.map(c => (
            <button key={c.id} type="button" onClick={() => onLink(c)} disabled={linking}
              className="w-full text-left px-3 py-2 text-[12px] hover:bg-bg transition-colors flex items-center gap-2 disabled:opacity-60">
              <Check className="w-3.5 h-3.5 text-transparent" />
              <span className="min-w-0">
                <span className="block font-medium text-ink truncate">{c.name}</span>
                {(c.email || c.phone) && (
                  <span className="block text-[10px] text-ink-3 truncate">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
      <button onClick={() => { setOpen(false); setQ('') }}
        className="w-full text-center text-[11px] text-ink-3 hover:text-ink-2 py-0.5">
        Cancel
      </button>
    </div>
  )
}
