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
 *
 * The day-by-day bars all share ONE hours axis (the week's busiest day's
 * available hours), not a per-day percentage. Each day used to fill 0–100%
 * of *its own* availability, so a light Sunday at capacity looked exactly
 * as "full" as a heavily-staffed Saturday at capacity — same bar height for
 * very different absolute hours, the normalized-comparison trap the dataviz
 * skill flags under dual-axis/mixed-scale charts. Booked hours are now the
 * bar; that day's own available hours is a thin benchmark tick on the same
 * axis, so height is comparable across days AND still shows over/under that
 * day's cap.
 */
import { Gauge } from 'lucide-react'
import { Tile, TileLoading, BarTip } from './primitives'

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

          {/* Day-by-day mini bars — one shared hours axis (see header note). */}
          {(data?.days || []).length > 0 && (() => {
            const weekMaxAvailable = Math.max(1, ...data.days.map(d => d.available_hours || 0))
            const lastIdx = data.days.length - 1
            return (
              <>
                <div className="mt-4 grid grid-cols-7 gap-2">
                  {data.days.map((d, i) => {
                    const bookedPct = Math.min(100, Math.round(((d.booked_hours || 0) / weekMaxAvailable) * 100))
                    const availPct = Math.min(100, Math.round(((d.available_hours || 0) / weekMaxAvailable) * 100))
                    const dayOver = d.booked_hours > d.available_hours && d.booked_hours > 0
                    const align = i === 0 ? 'start' : i === lastIdx ? 'end' : 'center'
                    return (
                      <BarTip key={d.date} align={align} wrap
                        value={`${d.booked_hours}h booked`}
                        label={`/ ${d.available_hours}h avail · ${d.jobs} job${d.jobs === 1 ? '' : 's'}`}
                        className="flex-col items-center gap-1 w-full">
                        <div className="relative w-full h-10 rounded bg-bg-2 overflow-hidden">
                          {/* Rounded data-end at the fill's top (away from the
                              baseline), square at the bottom — mark spec. */}
                          <div
                            className={`absolute bottom-0 inset-x-0 rounded-t-sm ${dayOver ? 'bg-amber-500' : 'bg-indigo-500'}`}
                            style={{ height: `${bookedPct}%` }}
                          />
                          {d.available_hours > 0 && (
                            <div className="absolute inset-x-0 h-px bg-ink-3/70" style={{ bottom: `${availPct}%` }} aria-hidden="true" />
                          )}
                        </div>
                        <span className="text-[11px] text-ink-3">{DAY_LETTER[d.weekday] || ''}</span>
                      </BarTip>
                    )
                  })}
                </div>
                {/* Two series share this grid (booked bar vs. that day's
                    available-hours line) — identity comes from mark shape
                    (fill vs. line), not color alone, per the dot+word rule. */}
                <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-3">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-1.5 rounded-[1px] bg-indigo-500 shrink-0" aria-hidden="true" /> Booked
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-px bg-ink-3/70 shrink-0" aria-hidden="true" /> Available that day
                  </span>
                </div>
              </>
            )
          })()}

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
