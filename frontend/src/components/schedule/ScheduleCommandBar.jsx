/**
 * Schedule command bar — the compact, packing header above the calendar on the
 * office (desktop Day / Week / Month) views.
 *
 * Why it exists: the office views used to stack TWO full-width bands above the
 * calendar — ScheduleHealthStrip's today/week count row and NeedsDateStrip —
 * and the actionable OpsAlerts (needs-crew / subs-waiting, with the existing
 * "Open to crew" action) only ever rendered inside the phone AgendaHero, so a
 * desktop dispatcher never saw them. This merges those two bands into one dense
 * bento row and brings the alerts to the desktop, matching the OpsBoard
 * command-center rhythm (hairline cards, quiet dot+word, one reveal per tier).
 *
 * Pure presentation: it composes existing components (OpsAlerts, NeedsDateStrip)
 * and reuses the data + callbacks Schedule.jsx already has — no new fetch, no new
 * mutation, no calendar/writeback change. The alert boxes and the needs-a-date
 * box each render nothing when empty, so a calm day collapses to the thin KPI
 * line (Week/Month) or to nothing at all (Day, where DayBoard owns the summary).
 * Design language: quiet dots carry severity, no tinted banners / pills / count
 * bubbles.
 */
import { Calendar as CalendarIcon, Clock } from 'lucide-react'
import OpsAlerts from './OpsAlerts'
import NeedsDateStrip from './NeedsDateStrip'

export default function ScheduleCommandBar({
  stats,
  weekLabel = 'This week',
  // Day (DayBoard) carries its own big date header + OpsSummary, so the KPI
  // line here would just echo the today count — suppress it there and let this
  // bar contribute only the actionable alerts + needs-a-date. Week/Month have
  // no other summary, so they keep the KPI line.
  showKpis = true,
  todayStats,
  unassignedToday,
  awaitingReply,
  unscheduled,
  onSchedule,
  onFocusUnassigned,
  onOpenToCrew,
}) {
  const needsDate = Array.isArray(unscheduled) ? unscheduled : []
  const hasNeedsDate = needsDate.length > 0

  // Mirror OpsAlerts' own render condition exactly, so the alert column only
  // mounts when the component will actually draw a card — otherwise a busy
  // needs-a-date day would leave a dead half-width cell (owner: "too much empty
  // spaces lol").
  const waiting = awaitingReply || []
  const hasAlerts =
    waiting.length > 0
    || (todayStats?.unassigned || 0) > 0
    || ((todayStats?.jobs || 0) > 0 && (todayStats?.capacityPct || 0) >= 90)

  const showKpiLine = showKpis && !!stats
  if (!showKpiLine && !hasAlerts && !hasNeedsDate) return null

  return (
    <div className="no-print bg-bg border-b border-hairline">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2 bb-board-in">
        {/* At-a-glance counts (was ScheduleHealthStrip). */}
        {showKpiLine && (
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-ink-2">
              <CalendarIcon className="w-4 h-4 text-ink-3" />
              <span className="font-semibold text-ink tabular-nums">{stats.today ?? 0}</span>
              <span className="text-ink-3">today</span>
            </span>
            <span className="w-px h-4 bg-hairline" />
            <span className="flex items-center gap-1.5 text-ink-2">
              <Clock className="w-4 h-4 text-ink-3" />
              <span className="font-semibold text-ink tabular-nums">{stats.week ?? 0}</span>
              <span className="text-ink-3 lowercase">{weekLabel}</span>
            </span>
          </div>
        )}

        {/* The bento: alerts and the needs-a-date list pack side by side on a
            wide window and stack below it — never a stack of full-width bands.
            Each column is mounted only when it has something to draw, so a
            single active box takes the full width instead of leaving dead space. */}
        {(hasAlerts || hasNeedsDate) && (
          <div className={`flex flex-col gap-1.5 shell:flex-row shell:items-start shell:gap-3 ${showKpiLine ? 'mt-1' : ''}`}>
            {hasAlerts && (
              <div className="min-w-0 flex-1">
                <OpsAlerts
                  stats={todayStats}
                  unassignedToday={unassignedToday}
                  awaitingReply={awaitingReply}
                  onFocusUnassigned={onFocusUnassigned}
                  onOpenToCrew={onOpenToCrew}
                />
              </div>
            )}
            {hasNeedsDate && (
              <div className="min-w-0 flex-1">
                <NeedsDateStrip jobs={needsDate} onSchedule={onSchedule} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
