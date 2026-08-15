/**
 * CrewHoursTile — hours per cleaner this week from the native time clock
 * (GET /api/payroll/summary for the Mon–Sun window; same endpoint the
 * Payroll page runs on, so the two can never disagree).
 *
 * Per-cleaner rows with a thin indigo bar scaled to the busiest cleaner.
 * Unclassified hours (punches not clocked into a job) get an amber dot on the
 * row — they're counted in the total but unpaid until assigned, which is
 * exactly the kind of thing that should be visible before payday, not on it.
 */
import { Clock } from 'lucide-react'
import { Tile, TileLoading, BarTip } from './primitives'

export function CrewHoursTile({ loading, data, error, navigate }) {
  const employees = (data?.employees || [])
    .filter(e => (e.total_hours || 0) > 0 || (e.unclassified_hours || 0) > 0)
    .sort((a, b) => (b.total_hours || 0) - (a.total_hours || 0))
  const maxHours = Math.max(...employees.map(e => e.total_hours || 0), 1)
  const anyUnclassified = employees.some(e => (e.unclassified_hours || 0) > 0)

  return (
    <Tile icon={Clock} title="Crew hours this week"
      action="Open payroll" onAction={() => navigate('/payroll')}>
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">Couldn't load crew hours.</div>
      ) : employees.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">
          No hours on the clock yet this week.
        </div>
      ) : (
        <>
          <div className="px-5 py-3 space-y-3">
            {employees.map(e => (
              <div key={e.employee_id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-1.5 min-w-0 text-[13px] font-medium text-ink truncate">
                    {(e.unclassified_hours || 0) > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                            title={`${e.unclassified_hours}h not clocked into a job`} aria-hidden="true" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </span>
                  <span className="text-sm tabular-nums text-ink shrink-0">
                    {e.total_hours}h
                    {(e.unclassified_hours || 0) > 0 && (
                      <span className="text-[11px] text-ink-3"> · {e.unclassified_hours}h unclassified</span>
                    )}
                  </span>
                </div>
                <BarTip value={`${e.total_hours}h`} label={`· ${e.name}`} className="mt-1 w-full">
                  <div className="w-full h-1 rounded-full bg-bg-2 overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-500"
                         style={{ width: `${Math.round(((e.total_hours || 0) / maxHours) * 100)}%` }} />
                  </div>
                </BarTip>
              </div>
            ))}
          </div>
          {anyUnclassified && (
            <div className="px-5 py-2.5 border-t border-hairline text-[11px] text-ink-3">
              Unclassified hours are counted but unpaid until the punch is assigned to a job.
            </div>
          )}
        </>
      )}
    </Tile>
  )
}
