import { useState, useEffect } from 'react'
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { get } from '../api'

// Read-only CRM health snapshot, backed by GET /api/clients/health. Answers
// "how many of these leads are actually real?" before any cleanup runs — it never
// mutates anything. Buckets are mutually exclusive and sum to the total.
const BUCKET_META = {
  real:           { label: 'Real',            cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20' },
  duplicate:      { label: 'Duplicates',      cls: 'bg-amber-500/15 text-amber-500 border-amber-500/20' },
  spam_marketing: { label: 'Spam / marketing', cls: 'bg-rose-500/15 text-rose-500 border-rose-500/20' },
  incomplete:     { label: 'Incomplete',      cls: 'bg-sky-500/15 text-sky-500 border-sky-500/20' },
  test:           { label: 'Test / junk',     cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20' },
}
const ORDER = ['real', 'duplicate', 'spam_marketing', 'incomplete', 'test']

function Breakdown({ title, obj }) {
  const entries = Object.entries(obj || {})
  if (!entries.length) return null
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} className="px-2 py-0.5 rounded-md text-[11px] bg-bg-2 text-ink-2 border border-hairline">
            {k}: {v}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function CRMHealthPanel() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true); setError(null)
    get('/api/clients/health')
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }

  // Lazy: only scan when first expanded, so opening the Clients page stays cheap.
  useEffect(() => { if (open && !data && !loading && !error) load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = data?.total ?? 0
  const real = data?.buckets?.real?.count ?? 0
  const pctReal = total ? Math.round((real / total) * 100) : 0

  return (
    <div className="mb-3 border border-hairline rounded-lg bg-panel">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-2 hover:text-ink transition-colors">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Activity className="w-3.5 h-3.5 text-blue-500" />
        CRM health
        {data && <span className="text-ink-3 font-normal">— {pctReal}% real ({real}/{total})</span>}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-hairline">
          {loading && <div className="text-[12px] text-ink-3 py-2">Scanning clients…</div>}

          {error && !loading && (
            <div className="text-[12px] text-rose-500 py-2 flex items-center gap-2">
              {error}
              <button onClick={load} className="inline-flex items-center gap-1 text-ink-3 hover:text-ink-2">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          )}

          {data && !loading && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 py-2">
                {ORDER.map(k => {
                  const m = BUCKET_META[k]
                  const n = data.buckets?.[k]?.count ?? 0
                  return (
                    <span key={k} className={`px-2 py-1 rounded-md text-[11px] font-medium border ${m.cls}`}>
                      {m.label}: {n}
                    </span>
                  )
                })}
                <button onClick={load} title="Refresh"
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                <Breakdown title="By source" obj={data.by_source} />
                <Breakdown title="By status" obj={data.by_status} />
              </div>

              <p className="text-[11px] text-ink-3 mt-2">
                Read-only snapshot — nothing is changed. Buckets are mutually exclusive and sum to {total}.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
