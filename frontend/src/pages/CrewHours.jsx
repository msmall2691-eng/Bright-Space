/**
 * Crew Hours — reconciliation view (office / admin-manager).
 *
 * Native clock hours (the `time_entries` table, Phase 2a) vs. Connecteam's
 * hours, per cleaner, for a date range. This is the proof step: run the native
 * clock alongside Connecteam and confirm the numbers agree before payroll ever
 * reads native hours. Read-only — reads Connecteam the same way payroll does
 * and never writes it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Scale, RefreshCw, Check, AlertTriangle } from 'lucide-react'
import { get } from '../api'
import { PageHeader, EmptyState, ErrorState, Skeleton } from '../components/ui'

const fmtH = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}h`)
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}h`)

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function CrewHours() {
  const [start, setStart] = useState(isoDaysAgo(14))
  const [end, setEnd] = useState(isoDaysAgo(0))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const pull = useCallback((s, e) => {
    setLoading(true); setError(null)
    get(`/api/crew/reconciliation?start=${s}&end=${e}`)
      .then(setData).catch(setError).finally(() => setLoading(false))
  }, [])

  // Initial load; the operator re-runs with the button after changing dates.
  useEffect(() => { pull(start, end) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const people = data?.people || []
  const totals = data?.totals

  return (
    <div className="pb-10">
      <PageHeader
        icon={Scale}
        iconColor="violet"
        title="Crew Hours"
        subtitle="Native clock vs. Connecteam — reconcile before payroll depends on the native clock."
      />

      <div className="px-4 sm:px-8 space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-3">
            <div className="mb-1">Start</div>
            <input type="date" value={start} onChange={e => setStart(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm text-ink" />
          </label>
          <label className="text-xs text-ink-3">
            <div className="mb-1">End</div>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm text-ink" />
          </label>
          <button onClick={() => pull(start, end)} disabled={loading}
            className="text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg inline-flex items-center gap-1.5 transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Run
          </button>
        </div>

        {data && !data.connecteam_configured && (
          <div className="text-[13px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Connecteam isn’t connected, so this shows native clock hours only. Once it’s set up, the two columns compare side by side.</span>
          </div>
        )}
        {data?.connecteam_error && (
          <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            Couldn’t read Connecteam: {data.connecteam_error}
          </div>
        )}

        {loading && (
          <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-11 w-full rounded-lg" />)}</div>
        )}

        {!loading && error && <ErrorState onRetry={() => pull(start, end)} compact />}

        {!loading && !error && data && (
          people.length === 0 ? (
            <EmptyState icon={Scale} title="No hours in this range"
              description="No native punches (or Connecteam hours) for the selected dates." compact />
          ) : (
            <div className="overflow-x-auto border border-hairline rounded-xl bg-panel">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-hairline">
                    <th className="px-3 py-2 font-semibold">Cleaner</th>
                    <th className="px-3 py-2 font-semibold text-right">Native clock</th>
                    <th className="px-3 py-2 font-semibold text-right">Connecteam</th>
                    <th className="px-3 py-2 font-semibold text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map(p => (
                    <tr key={p.cleaner_id} className="border-b border-hairline last:border-0">
                      <td className="px-3 py-2 text-ink">{p.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtH(p.native_hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtH(p.connecteam_hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.delta_hours == null ? (
                          <span className="text-ink-3">—</span>
                        ) : p.match ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <Check className="w-3.5 h-3.5" /> {signed(p.delta_hours)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600">
                            <AlertTriangle className="w-3.5 h-3.5" /> {signed(p.delta_hours)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t border-hairline font-semibold text-ink">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtH(totals.native_hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtH(totals.connecteam_hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{signed(totals.delta_hours)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )
        )}
      </div>
    </div>
  )
}
