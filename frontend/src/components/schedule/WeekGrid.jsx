import { useMemo, useEffect, useRef, useState } from 'react'
import { Calendar as CalendarIcon, Plus, AlertCircle, Users } from 'lucide-react'
import Button from '../ui/Button'
import { toLocalYMD, todayYMD } from '../../utils/format'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  PROPERTY_TYPE_CONFIG,
  VISIT_STATUS_CONFIG,
  computeDisplayStatus,
} from './constants'
import {
  layoutDayColumn,
  computeHourBand,
  positionForBlock,
  splitTimedUntimed,
  weekDaysContaining,
  parseTimeToHour,
  WEEK_GRID_CONSTANTS,
} from './weekGridLayout'

/**
 * Week / time-grid view. Seven day columns × an hour rail; each timed job
 * renders as a positioned block whose vertical placement is
 *   top = (start - band.startHour) / (band.endHour - band.startHour)
 *   height = duration / band-height
 * and overlapping jobs are packed into side-by-side lanes via layoutDayColumn.
 * Untimed jobs (needs_setup / no start_time) show in a thin amber strip at
 * the top of their column so they can't be silently hidden.
 *
 * PR A scope: read-only. No drag-to-reschedule, no click-empty-slot create
 * (both are PR B). Tapping a block calls onOpen(visit) so the parent can
 * open the shared VisitDetailsDrawer that agenda already uses.
 *
 * Props:
 *   currentDate    — any date inside the week to render (Sun-Sat window).
 *   filteredVisits — the parent's already-filtered visit list; we bucket
 *                    it by day here. Visit shape mirrors the /api/schedule/week
 *                    payload (see useScheduleData).
 *   jobs, properties, clients — id-keyed maps for rendering job metadata.
 *   empName(id)    — resolves cleaner id → display name (fallback initials).
 *   onOpen(visit)  — parent opens the detail drawer (audit §7 unify).
 *   onNewJob(dateStr) — toolbar "New Job" callback (empty-slot create is PR B).
 */
const HOUR_ROW_PX = 56
const UNTIMED_STRIP_PX = 34

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function WeekGrid({
  currentDate,
  filteredVisits = [],
  jobs = {},
  properties = {},
  clients = {},
  empName,
  onOpen,
  onNewJob,
}) {
  const isMobile = useIsMobile()

  const days = useMemo(() => weekDaysContaining(currentDate), [currentDate])

  // Bucket visits by date, then compute per-day timed layout + untimed strip.
  const perDay = useMemo(() => {
    const byDay = {}
    for (const d of days) byDay[d] = []
    for (const v of filteredVisits) {
      if (v.scheduled_date && byDay[v.scheduled_date]) byDay[v.scheduled_date].push(v)
    }
    return days.map(d => {
      const split = splitTimedUntimed(byDay[d])
      // layoutDayColumn wants {id, start_time, end_time}; use the visit id so
      // the returned lanes line up with the visits themselves.
      const lanes = layoutDayColumn(split.timed)
      const byVisitId = new Map(lanes.map(l => [l.jobId, l]))
      return {
        date: d,
        timed: split.timed,
        untimed: split.untimed,
        laneByVisitId: byVisitId,
      }
    })
  }, [days, filteredVisits])

  // Auto-expand the visible hour band to fit anything outside the default.
  const band = useMemo(() => computeHourBand(filteredVisits), [filteredVisits])
  const gridHeightPx = (band.endHour - band.startHour) * HOUR_ROW_PX

  // Current-time indicator — recompute every 5 minutes; frequent enough for
  // a shift schedule, cheap enough not to bother anyone.
  const [nowInDay, setNowInDay] = useState(() => nowHourInLocal())
  useEffect(() => {
    const t = setInterval(() => setNowInDay(nowHourInLocal()), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  // Mobile fallback (audit §7): 7-column grid is unusable at phone width.
  // Render a friendly "switch to Day" hint; the toolbar's view toggle stays
  // available at the top of the page.
  if (isMobile) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-16 text-center">
        <div>
          <CalendarIcon className="w-8 h-8 text-ink-3 mx-auto mb-3" />
          <p className="text-sm text-ink-2 font-medium">Week view isn't sized for phones</p>
          <p className="text-xs text-ink-3 mt-1">
            Switch to <strong>Day</strong> in the toolbar for a mobile-friendly agenda,
            or open Week on a tablet or desktop.
          </p>
        </div>
      </div>
    )
  }

  const todayStr = todayYMD()
  const monthLabel = new Date(days[0] + 'T12:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  }) + ' – ' + new Date(days[6] + 'T12:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })

  const totalVisits = filteredVisits.length
  if (totalVisits === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16 text-center">
        <CalendarIcon className="w-10 h-10 text-ink-3 mb-3" />
        <p className="text-ink-2 font-semibold">No jobs scheduled this week</p>
        <p className="text-xs text-ink-3 mt-1">{monthLabel}</p>
        {onNewJob && (
          <Button
            variant="primary" size="sm"
            onClick={() => onNewJob(days[0])}
            className="mt-4"
            data-testid="week-grid-new-job"
          >
            <Plus className="w-4 h-4 mr-1" /> New Job
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col" data-testid="week-grid">
      {/* Week header — one row of day labels + a small count-badge per day. */}
      <div className="border-b border-hairline bg-panel/70 backdrop-blur-sm sticky top-0 z-10">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(7, minmax(0, 1fr))` }}>
          <div className="border-r border-hairline" />
          {days.map((d, i) => {
            const dObj = new Date(d + 'T12:00')
            const dayCount = perDay[i].timed.length + perDay[i].untimed.length
            const isToday = d === todayStr
            return (
              <div
                key={d}
                className={`px-2 py-2 text-center border-r border-hairline last:border-r-0 ${isToday ? 'bg-blue-50' : ''}`}
              >
                <div className={`text-[10px] uppercase font-semibold tracking-wide ${isToday ? 'text-blue-700' : 'text-ink-3'}`}>
                  {DAY_LABELS[i]}
                </div>
                <div className={`text-lg font-bold ${isToday ? 'text-blue-800' : 'text-ink'}`}>
                  {dObj.getDate()}
                </div>
                {dayCount > 0 && (
                  <div className="text-[10px] text-ink-3 mt-0.5">
                    {dayCount} {dayCount === 1 ? 'job' : 'jobs'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Grid body: hour rail + 7 columns. Scroll-y within the grid so the
          header stays visible. */}
      <div className="flex-1 overflow-auto">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(7, minmax(0, 1fr))`, minHeight: gridHeightPx + UNTIMED_STRIP_PX }}>
          {/* Hour rail */}
          <div className="border-r border-hairline">
            <div style={{ height: UNTIMED_STRIP_PX }} />
            {hoursInBand(band).map((h) => (
              <div key={h} className="text-[10px] text-ink-3 pr-1 text-right leading-none" style={{ height: HOUR_ROW_PX }}>
                <span className="relative -top-1.5">{formatHour(h)}</span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {perDay.map(({ date, timed, untimed, laneByVisitId }) => (
            <DayColumn
              key={date}
              date={date}
              todayStr={todayStr}
              band={band}
              hourRowPx={HOUR_ROW_PX}
              untimedStripPx={UNTIMED_STRIP_PX}
              timedVisits={timed}
              untimedVisits={untimed}
              laneByVisitId={laneByVisitId}
              jobs={jobs}
              properties={properties}
              clients={clients}
              empName={empName}
              onOpen={onOpen}
              nowInDay={nowInDay}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DayColumn({
  date, todayStr, band, hourRowPx, untimedStripPx,
  timedVisits, untimedVisits, laneByVisitId,
  jobs, properties, clients, empName, onOpen, nowInDay,
}) {
  const isToday = date === todayStr
  const gridHeightPx = (band.endHour - band.startHour) * hourRowPx

  return (
    <div className={`border-r border-hairline last:border-r-0 relative ${isToday ? 'bg-blue-50/30' : ''}`}>
      {/* Untimed strip — jobs with no start_time. Amber to signal
          "needs_setup"-like state and keep them from vanishing. */}
      <div
        className={`border-b border-hairline bg-amber-50/40 ${untimedVisits.length === 0 ? 'opacity-0' : ''}`}
        style={{ height: untimedStripPx }}
        title={untimedVisits.length > 0 ? 'Unscheduled time — needs a start time' : undefined}
      >
        {untimedVisits.length > 0 && (
          <div className="flex items-center gap-1 px-1.5 py-1 overflow-hidden">
            <AlertCircle className="w-3 h-3 text-amber-600 shrink-0" />
            <div className="flex gap-1 overflow-x-auto scrollbar-thin">
              {untimedVisits.map(v => (
                <VisitChip
                  key={v.id}
                  visit={v}
                  jobs={jobs}
                  properties={properties}
                  clients={clients}
                  empName={empName}
                  onOpen={onOpen}
                  compact
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Hour-lined body */}
      <div className="relative" style={{ height: gridHeightPx }}>
        {/* Faint horizontal lines every hour so the block positions are readable. */}
        {hoursInBand(band).map((h, i) => (
          <div
            key={h}
            className="absolute left-0 right-0 border-t border-hairline/60"
            style={{ top: i * hourRowPx }}
          />
        ))}

        {/* Current-time indicator — only in today's column. */}
        {isToday && nowInDay >= band.startHour && nowInDay <= band.endHour && (
          <div
            className="absolute left-0 right-0 h-px bg-red-500 z-20"
            style={{ top: ((nowInDay - band.startHour) / (band.endHour - band.startHour)) * gridHeightPx }}
            data-testid="week-grid-now-line"
          >
            <div className="absolute -left-1 -top-1 w-2 h-2 bg-red-500 rounded-full" />
          </div>
        )}

        {/* Timed job blocks */}
        {timedVisits.map(v => {
          const lane = laneByVisitId.get(v.id)
          if (!lane) return null
          const pos = positionForBlock(lane.startHour, lane.endHour, band)
          const leftPct = (lane.laneIndex / lane.laneCount) * 100
          const widthPct = (1 / lane.laneCount) * 100
          return (
            <VisitBlock
              key={v.id}
              visit={v}
              jobs={jobs}
              properties={properties}
              clients={clients}
              empName={empName}
              onOpen={onOpen}
              topPct={pos.topPct}
              heightPct={pos.heightPct}
              leftPct={leftPct}
              widthPct={widthPct}
              gridHeightPx={gridHeightPx}
            />
          )
        })}
      </div>
    </div>
  )
}

function VisitBlock({ visit, jobs, properties, clients, empName, onOpen, topPct, heightPct, leftPct, widthPct, gridHeightPx }) {
  const job = jobs[visit.job_id] || visit
  const property = properties[job.property_id]
  const client = clients[job.client_id]
  const propertyType = property?.property_type || job?.job_type || 'residential'
  const cfg = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  const displayStatus = computeDisplayStatus({ ...visit, property_id: job?.property_id })
  const statusCfg = VISIT_STATUS_CONFIG[displayStatus] || VISIT_STATUS_CONFIG.scheduled
  const cleaners = visit.cleaner_ids || []
  const isCancelled = visit.status === 'cancelled'

  const heightPx = Math.max(28, heightPct * gridHeightPx)  // min-height so short jobs stay clickable
  const style = {
    top: `${topPct * 100}%`,
    height: heightPx,
    left: `calc(${leftPct}% + 2px)`,
    width: `calc(${widthPct}% - 4px)`,
  }

  const label = client?.name || property?.address || job?.title || 'Job'
  const timeLabel = formatTimeRange(visit.start_time, visit.end_time)

  return (
    <button
      type="button"
      className={`absolute rounded-md border shadow-sm text-left overflow-hidden transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${cfg.pill} ${isCancelled ? 'opacity-50 line-through' : ''}`}
      style={style}
      onClick={() => onOpen && onOpen(visit)}
      data-testid={`week-grid-block-${visit.id}`}
      title={`${timeLabel} · ${label}`}
    >
      <div className="px-1.5 py-1 flex flex-col h-full">
        <div className="flex items-center gap-1 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
          <span className="text-[10px] font-semibold truncate">{timeLabel}</span>
        </div>
        <div className="text-[11px] font-medium truncate mt-0.5">{label}</div>
        {heightPx > 48 && (
          <div className="mt-auto flex items-center gap-1 text-[10px] text-ink-3">
            {cleaners.length === 0 ? (
              <span className="inline-flex items-center gap-0.5 text-amber-700 font-medium">
                <AlertCircle className="w-2.5 h-2.5" /> Needs cleaner
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 truncate">
                <Users className="w-2.5 h-2.5" />
                <span className="truncate">
                  {cleaners.slice(0, 2).map(id => (empName ? empName(id) : String(id))).join(', ')}
                  {cleaners.length > 2 ? ` +${cleaners.length - 2}` : ''}
                </span>
              </span>
            )}
            <span className={`ml-auto text-[9px] px-1 rounded shrink-0 ${statusCfg.pillMobile}`}>{statusCfg.label}</span>
          </div>
        )}
      </div>
    </button>
  )
}

function VisitChip({ visit, jobs, properties, clients, empName, onOpen, compact }) {
  const job = jobs[visit.job_id] || visit
  const property = properties[job.property_id]
  const client = clients[job.client_id]
  const propertyType = property?.property_type || job?.job_type || 'residential'
  const cfg = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  const label = client?.name || property?.address || job?.title || 'Job'
  return (
    <button
      type="button"
      onClick={() => onOpen && onOpen(visit)}
      className={`shrink-0 max-w-[140px] truncate text-[10px] px-1.5 py-0.5 rounded border ${cfg.pill}`}
      title={label}
      data-testid={`week-grid-untimed-${visit.id}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${cfg.dot}`} />
      {label}
    </button>
  )
}

function hoursInBand(band) {
  const out = []
  for (let h = band.startHour; h < band.endHour; h++) out.push(h)
  return out
}

function formatHour(h) {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  if (h < 12) return `${h}a`
  return `${h - 12}p`
}

function formatTimeRange(start, end) {
  const s = parseTimeToHour(start)
  const e = parseTimeToHour(end)
  if (s == null) return ''
  const startLabel = formatHalf(s)
  const endLabel = e != null && e > s ? formatHalf(e) : formatHalf(s + WEEK_GRID_CONSTANTS.DEFAULT_DURATION_HOURS)
  return `${startLabel} – ${endLabel}`
}

function formatHalf(h) {
  const wholeH = Math.floor(h)
  const min = Math.round((h - wholeH) * 60)
  const suffix = wholeH >= 12 ? 'p' : 'a'
  const display = wholeH % 12 === 0 ? 12 : wholeH % 12
  if (min === 0) return `${display}${suffix}`
  return `${display}:${String(min).padStart(2, '0')}${suffix}`
}

/**
 * Current local time as a float hour (0-24). Used for the "now" line — it's
 * a UI cue, not a scheduling decision, so we accept the OS timezone here
 * (the app operates in America/New_York; ops running elsewhere still see
 * "their local now" which is what the header says anyway).
 */
function nowHourInLocal() {
  const d = new Date()
  return d.getHours() + d.getMinutes() / 60
}
