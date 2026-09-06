/**
 * Agenda hero — the mobile-first "Today at a glance" band.
 *
 * Composes four pieces above AgendaDay's card list so a dispatcher opening
 * the app on their phone lands on the ops summary, not a month grid full
 * of "10:00" pills:
 *
 *   1. Big weekday+date header (replaces AgendaDay's own header for the
 *      mobile agenda view)
 *   2. OpsSummary chip strip (jobs · need a crew · capacity · crews out)
 *   3. RouteRibbon — 6a–8p horizontal timeline
 *   4. DateStrip — 7-day chip strip with load bars
 *   5. OpsAlerts — actionable warnings (unassigned + capacity)
 *
 * All of these render as no-ops or hide chrome when they have no signal to
 * add, so an empty day reads clean instead of scaffolded.
 */
import OpsSummary from './OpsSummary'
import RouteRibbon from './RouteRibbon'
import DateStrip from './DateStrip'
import OpsAlerts from './OpsAlerts'
import DayActionButtons from './DayActionButtons'
import { toLocalYMD, todayYMD } from '../../utils/format'

export default function AgendaHero({
  currentDate,
  todayVisits,
  todayStats,
  unassignedToday,
  awaitingReply,
  weekDates,
  loadByDate,
  jobs,
  properties,
  isToday,
  onDateSelect,
  onFocusUnassigned,
  onOpenToCrew,
}) {
  const dateLabel = new Date(`${toLocalYMD(currentDate)}T00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
  const weekday = dateLabel.split(',')[0]
  const monthDay = dateLabel.split(',')[1]?.trim() || ''

  return (
    <div className="border-b border-hairline bg-bg">
      {/* Header — takes the place of AgendaDay's own header when hero is on */}
      <div className="px-4 pt-3 pb-1 flex items-start justify-between gap-2">
        <div>
          {isToday && (
            <div className="text-[10px] font-mono tracking-widest uppercase text-ink-3 mb-0.5">
              Today
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <h2 className="text-[26px] font-bold text-ink tracking-tight leading-tight">
              {weekday}
            </h2>
            <span className="text-[20px] text-ink-3 font-medium leading-tight">
              {monthDay}
            </span>
          </div>
        </div>
        <DayActionButtons visits={todayVisits} jobs={jobs} properties={properties} className="mt-1" />
      </div>

      {/* Dashboard-y sub-sections — not useful on a printed day sheet, so
          they're hidden there; the weekday header + AgendaDay's job list
          below are what should actually print. */}
      <div className="no-print">
        <OpsSummary stats={todayStats} isToday={isToday} />
        <RouteRibbon visits={todayVisits} jobs={jobs} properties={properties} />
        <DateStrip
          weekDates={weekDates}
          loadByDate={loadByDate}
          currentDate={currentDate}
          onSelect={onDateSelect}
          todayStr={todayYMD()}
        />
        <OpsAlerts
          stats={todayStats}
          unassignedToday={unassignedToday}
          awaitingReply={awaitingReply}
          onFocusUnassigned={onFocusUnassigned}
          onOpenToCrew={onOpenToCrew}
        />
      </div>
    </div>
  )
}
