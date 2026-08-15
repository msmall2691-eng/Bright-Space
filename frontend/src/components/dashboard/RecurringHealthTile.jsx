/**
 * RecurringHealthTile — a one-glance rollup of the Recurring Doctor audit
 * (GET /api/recurring/cleanup/health): how many series have a problem, split
 * by severity, linking to the Recurring page's Health check panel where each
 * issue carries its suggested fix. Cheap by design: one GET, render counts.
 *
 * An issue's severity is its WORST problem (error > warn > info) — same
 * ordering the audit itself sorts by.
 */
import { Repeat } from 'lucide-react'
import { Tile, TileLoading } from './primitives'

/** Split the audit's issues by their worst problem severity. Exported for
 *  the component test. */
export function splitBySeverity(issues) {
  const out = { error: 0, warn: 0, info: 0 }
  for (const issue of issues || []) {
    const sevs = (issue.problems || []).map(p => p.severity)
    const worst = sevs.includes('error') ? 'error' : sevs.includes('warn') ? 'warn' : 'info'
    out[worst] += 1
  }
  return out
}

const ROWS = [
  { key: 'error', dot: 'bg-red-500', label: n => `${n} error${n === 1 ? '' : 's'}` },
  { key: 'warn', dot: 'bg-amber-500', label: n => `${n} need${n === 1 ? 's' : ''} attention` },
  { key: 'info', dot: 'bg-ink-3', label: n => `${n} minor` },
]

export function RecurringHealthTile({ loading, data, error, navigate }) {
  const issues = data?.issues || []
  const sev = splitBySeverity(issues)
  return (
    <Tile icon={Repeat} title="Recurring health"
      action="Open Recurring" onAction={() => navigate('/recurring')}>
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">Couldn't load recurring health.</div>
      ) : issues.length === 0 ? (
        <div className="px-5 py-6 flex items-center gap-2 text-sm text-ink-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
          All {data?.scanned ?? 0} series healthy
        </div>
      ) : (
        <div className="px-5 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-ink">{issues.length}</span>
            <span className="text-[11px] text-ink-3">
              series with issues · {data?.healthy ?? 0} of {data?.scanned ?? 0} healthy
            </span>
          </div>
          <div className="mt-3 space-y-1.5">
            {ROWS.filter(r => sev[r.key] > 0).map(r => (
              <button key={r.key} onClick={() => navigate('/recurring')}
                className="flex items-center gap-2 text-[13px] text-ink hover:text-indigo-600">
                <span className={`w-1.5 h-1.5 rounded-full ${r.dot} shrink-0`} aria-hidden="true" />
                {r.label(sev[r.key])}
              </button>
            ))}
          </div>
        </div>
      )}
    </Tile>
  )
}
