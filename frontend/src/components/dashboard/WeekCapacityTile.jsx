/**
 * WeekCapacityTile — booked job hours vs available crew hours for the
 * current (Monday-anchored) week, from GET /api/dashboard/week-capacity.
 *
 * One big plain number (utilization %), a single horizontal bar, and seven
 * mini day-bars. Bars are indigo on a bg-2 track — amber only when a day (or
 * the week) is booked past availability, which is genuinely a "look at this"
 * state. The availability side comes from the crew app's own AM/PM
 * availability data; crew who never set a pattern are assumed 8h/day and the
 * footer says so rather than hiding the estimate.
 */
import { Gauge } from 'lucide-react'
import { Tile, TileLoading } from './primitives'

const DAY_LETTER = { mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S', sun: 'S' }

export function WeekCapacityTile({ loading, data, error, navigate }) {
  const pct = data?.utilization_pct
  const over = data != null && data.available_hours > 0 && data.booked_hours > data.available_hours
  return (
    <Tile icon={Gauge} title="Week capacity"
      action="Open schedule" onAction={() => navigate('/schedule')}>
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">Couldn't load week capacity.</div>
      ) : (
        <div className="px-5 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-ink">
              {pct != null ? `${pct}%` : '—'}
            </span>
            <span className="text-[11px] text-ink-3">booked</span>
            {over && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                over capacity
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            {data
              ? `${data.booked_hours}h of ${data.available_hours}h crew availability · Mon–Sun`
              : null}
          </div>

          {/* Week bar */}
          <div className="mt-3 h-1.5 rounded-full bg-bg-2 overflow-hidden">
            <div
              className={`h-full rounded-full ${over ? 'bg-amber-500' : 'bg-indigo-500'}`}
              style={{ width: `${Math.min(100, pct || 0)}%` }}
            />
          </div>

          {/* Day-by-day mini bars */}
          {(data?.days || []).length > 0 && (
            <div className="mt-4 grid grid-cols-7 gap-2">
              {data.days.map(d => {
                const dayPct = d.available_hours > 0
                  ? Math.min(100, Math.round((d.booked_hours / d.available_hours) * 100))
                  : (d.booked_hours > 0 ? 100 : 0)
                const dayOver = d.booked_hours > d.available_hours && d.booked_hours > 0
                return (
                  <div key={d.date} className="flex flex-col items-center gap-1"
                       title={`${d.date}: ${d.booked_hours}h booked · ${d.available_hours}h available · ${d.jobs} job${d.jobs === 1 ? '' : 's'}`}>
                    <div className="relative w-full h-10 rounded bg-bg-2 overflow-hidden">
                      <div
                        className={`absolute bottom-0 inset-x-0 ${dayOver ? 'bg-amber-500' : 'bg-indigo-500'}`}
                        style={{ height: `${dayPct}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-ink-3">{DAY_LETTER[d.weekday] || ''}</span>
                  </div>
                )
              })}
            </div>
          )}

          {data?.crew_without_pattern > 0 && (
            <div className="mt-3 text-[11px] text-ink-3">
              {data.crew_without_pattern} crew without availability set — assumed 8h/day.
            </div>
          )}
        </div>
      )}
    </Tile>
  )
}
