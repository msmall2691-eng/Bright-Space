import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Calendar as CalendarIcon, Plus, AlertCircle, Users } from 'lucide-react'
import Button from '../ui/Button'
import { patch } from '../../api'
import { toLocalYMD, todayYMD } from '../../utils/format'
import { useIsMobile } from '../../hooks/useIsMobile'
import RecurrenceScopeDialog from './RecurrenceScopeDialog'
import { rescheduleRecurringVisit } from '../../utils/recurringReschedule'
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
  pxToHour,
  hourToTimeString,
  planReschedule,
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
 * PR B additions:
 *  - Drag a block to another day/time → optimistic move + PATCH /api/jobs/{id}
 *    persisting scheduled_date + start_time + end_time (duration preserved).
 *    Snaps to 15-minute slots. On 409 (double-booking / time-off / capacity)
 *    the drop reverts and a toast with a "Reschedule anyway" action re-PATCHes
 *    with allow_conflicts=true — mirrors the month-grid override path from
 *    Week 1.
 *  - Click an empty slot (or the untimed strip's blank half) → onNewSlot(
 *    { date, start_time, end_time }) so the parent opens the create modal
 *    prefilled with the clicked day + start time. Falls back to onNewJob(date)
 *    when no slot handler is provided.
 *
 * Desktop DnD only in this pass — mobile falls back to agenda, so the touch
 * path from CalendarView isn't ported here (would be dead code).
 *
 * Props:
 *   currentDate    — any date inside the week to render (Sun-Sat window).
 *   filteredVisits — the parent's already-filtered visit list; we bucket
 *                    it by day here. Visit shape mirrors the /api/schedule/week
 *                    payload (see useScheduleData).
 *   jobs, properties, clients — id-keyed maps for rendering job metadata.
 *   empName(id)    — resolves cleaner id → display name (fallback initials).
 *   onOpen(visit)  — parent opens the detail drawer (audit §7 unify).
 *   onNewJob(dateStr) — toolbar "New Job" callback used for the empty-week CTA.
 *   onNewSlot({ date, start_time, end_time }) — PR B: click-empty-slot handler.
 *   onLocalMove(jobId, patch) — parent's optimistic-state hook; when supplied,
 *                    the parent syncs its local `jobs`/`visits` maps so the
 *                    block stays in the new position instead of snapping back
 *                    on the next render. Optional — the grid keeps a small
 *                    internal override map either way.
 *   toast          — the shared toastBus `toast` object; used for the 409
 *                    "Reschedule anyway" notice. When absent, drag-drop still
 *                    works but conflicts fall through to console.error like
 *                    they did before.
 *   onRefresh()    — called after a recurring-visit drag resolves via
 *                    "this and future"/"all" scope, since those can move
 *                    many jobs at once — a single-block optimistic move
 *                    can't represent that, so the parent refetches instead.
 *
 *   Recurring-awareness: dragging a visit with a recurring_schedule_id used
 *   to silently PATCH just that one Job (the "this visit only" footgun
 *   RecurrenceScopeDialog's header comment describes) with no indication
 *   the visit belonged to a series. It now interrupts the drop with the same
 *   scope dialog JobEditModal's save flow uses, routing to whichever of the
 *   three recurring endpoints (reschedule/split/resync) matches the chosen
 *   scope — see utils/recurringReschedule.js.
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
  onNewSlot,
  onLocalMove,
  onRefresh,
  toast,
}) {
  const isMobile = useIsMobile()

  const days = useMemo(() => weekDaysContaining(currentDate), [currentDate])

  // Optimistic drag override: {[visitId]: { scheduled_date, start_time, end_time }}.
  // When the parent has an onLocalMove hook we defer to its state; otherwise
  // we keep the override locally so the block visually moves on drop even
  // before the PATCH settles.
  const [override, setOverride] = useState({})
  const applyOverride = useCallback((v) => {
    const o = override[v.id]
    if (!o) return v
    return { ...v, scheduled_date: o.scheduled_date, start_time: o.start_time, end_time: o.end_time }
  }, [override])

  // Bucket visits by date, then compute per-day timed layout + untimed strip.
  const perDay = useMemo(() => {
    const byDay = {}
    for (const d of days) byDay[d] = []
    for (const raw of filteredVisits) {
      const v = applyOverride(raw)
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
  }, [days, filteredVisits, applyOverride])

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

  // Drag-to-reschedule state. `draggingVisit` is the block currently being
  // dragged (null when idle). `dropPreview` is where it would land if
  // released now — used to render the ghost block and to compute the drop
  // target on drop. The current-drop hour also lets the DayColumn draw a
  // subtle highlight of the target slot.
  const [draggingVisit, setDraggingVisit] = useState(null)
  const [dropPreview, setDropPreview] = useState(null)  // { date, startHour } | null

  // Pending scope choice for a drag that landed on a recurring visit — set
  // instead of committing the drop directly; cleared on choice or cancel.
  // { visitId, jobId, schedId, originalDate, newDate, newStart, newEnd, cleanerIds }
  const [recurringDrop, setRecurringDrop] = useState(null)
  const [scopeSaving, setScopeSaving] = useState(false)

  const handleRecurringScopeChoice = useCallback(async (scope) => {
    if (!recurringDrop) return
    setScopeSaving(true)
    try {
      const { message } = await rescheduleRecurringVisit(scope, recurringDrop)
      toast?.success(message)
      // "this" only ever moves one Job — onLocalMove keeps the block from
      // snapping back before the parent's next refetch. "future"/"all" can
      // move many jobs at once, which a single-block optimistic update can't
      // represent, so those refetch instead.
      if (scope === 'this' && onLocalMove) {
        onLocalMove(recurringDrop.jobId, {
          scheduled_date: recurringDrop.newDate,
          start_time: recurringDrop.newStart,
          end_time: recurringDrop.newEnd,
        })
      } else {
        onRefresh?.()
      }
    } catch (err) {
      toast?.error(err.message || 'Failed to reschedule this recurring visit')
    } finally {
      setScopeSaving(false)
      setRecurringDrop(null)
    }
  }, [recurringDrop, onLocalMove, onRefresh, toast])

  /**
   * Optimistic reschedule commit. Mirrors CalendarView.commitReschedule from
   * Week 1: on 409, revert + toast with a "Reschedule anyway" retry that
   * re-issues the PATCH with allow_conflicts=true; on any other error, revert
   * + surface the reason. Never blocks the drop UX.
   */
  const commitReschedule = useCallback(async (visitId, jobId, original, next, opts = {}) => {
    const { allowConflicts = false, isRetry = false } = opts
    // Local optimistic apply for the block position, in case the parent
    // hasn't wired onLocalMove — this component still visualizes the move.
    setOverride(o => ({ ...o, [visitId]: next }))
    if (onLocalMove) onLocalMove(jobId, next)
    try {
      await patch(`/api/jobs/${jobId}`, {
        scheduled_date: next.scheduled_date,
        start_time: next.start_time,
        end_time: next.end_time,
        ...(allowConflicts ? { allow_conflicts: true } : {}),
      })
      if (isRetry && toast) toast.success('Rescheduled with conflict override')
    } catch (err) {
      const status = err && (err.status || err.statusCode)
      const detail = (err && (err.detail || err.message)) || ''
      // Revert the optimistic move.
      setOverride(o => {
        const { [visitId]: _dropped, ...rest } = o
        return rest
      })
      if (onLocalMove) onLocalMove(jobId, original)
      if (status === 409 && toast) {
        toast.error(
          `Can't move: ${detail.slice(0, 160) || 'scheduling conflict'}`,
          {
            action: {
              label: 'Reschedule anyway',
              onClick: () => commitReschedule(visitId, jobId, original, next, {
                allowConflicts: true, isRetry: true,
              }),
            },
          },
        )
      } else if (toast) {
        toast.error(`Reschedule failed${detail ? ': ' + detail.slice(0, 160) : ''}`)
      } else {
        console.error('[WeekGrid] Reschedule failed:', err)
      }
    }
  }, [onLocalMove, toast])

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
        <p className="text-xs text-ink-3 mt-3">
          or <Link to="/properties" className="underline hover:text-ink-2">import a property's iCal feed</Link>
        </p>
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
                <div className={`text-[10px] uppercase font-semibold tracking-wide ${isToday ? 'text-indigo-700' : 'text-ink-3'}`}>
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
              /* PR B: drag-drop + click-empty-slot */
              draggingVisit={draggingVisit}
              dropPreview={dropPreview}
              onDragStartBlock={setDraggingVisit}
              onDragEndBlock={() => { setDraggingVisit(null); setDropPreview(null) }}
              onColumnDragOver={(nextPreview) => setDropPreview(nextPreview)}
              onColumnDrop={(targetDate, targetHour) => {
                if (!draggingVisit) return
                const jobId = draggingVisit.job_id ?? draggingVisit.id
                const original = {
                  scheduled_date: draggingVisit.scheduled_date,
                  start_time: draggingVisit.start_time,
                  end_time: draggingVisit.end_time,
                }
                const next = planReschedule({
                  originalStart: draggingVisit.start_time,
                  originalEnd: draggingVisit.end_time,
                  targetDate,
                  targetHour,
                })
                // No-op moves shouldn't hit the API.
                if (next.scheduled_date === original.scheduled_date
                    && next.start_time === original.start_time
                    && next.end_time === original.end_time) {
                  setDraggingVisit(null)
                  setDropPreview(null)
                  return
                }
                // A recurring visit's move is ambiguous — this occurrence
                // only, this-and-future, or the whole series? Interrupt with
                // the scope dialog instead of silently PATCHing just this
                // Job (see RecurrenceScopeDialog's header comment).
                if (draggingVisit.recurring_schedule_id) {
                  setRecurringDrop({
                    visitId: draggingVisit.id,
                    jobId,
                    schedId: draggingVisit.recurring_schedule_id,
                    originalDate: original.scheduled_date,
                    newDate: next.scheduled_date,
                    newStart: next.start_time,
                    newEnd: next.end_time,
                    cleanerIds: draggingVisit.cleaner_ids || [],
                  })
                  setDraggingVisit(null)
                  setDropPreview(null)
                  return
                }
                setDraggingVisit(null)
                setDropPreview(null)
                commitReschedule(draggingVisit.id, jobId, original, next)
              }}
              onEmptySlot={(startTime, endTime) => {
                if (onNewSlot) {
                  onNewSlot({ date, start_time: startTime, end_time: endTime })
                } else if (onNewJob) {
                  onNewJob(date)
                }
              }}
            />
          ))}
        </div>
      </div>
      {recurringDrop && (
        <RecurrenceScopeDialog
          mode="edit"
          onChoose={handleRecurringScopeChoice}
          onCancel={() => setRecurringDrop(null)}
          busy={scopeSaving}
        />
      )}
    </div>
  )
}

function DayColumn({
  date, todayStr, band, hourRowPx, untimedStripPx,
  timedVisits, untimedVisits, laneByVisitId,
  jobs, properties, clients, empName, onOpen, nowInDay,
  draggingVisit, dropPreview,
  onDragStartBlock, onDragEndBlock,
  onColumnDragOver, onColumnDrop,
  onEmptySlot,
}) {
  const isToday = date === todayStr
  const gridHeightPx = (band.endHour - band.startHour) * hourRowPx
  const bodyRef = useRef(null)

  // Resolve where the pointer is inside the timed body → a snapped hour.
  const pointerToHour = (e) => {
    const rect = bodyRef.current?.getBoundingClientRect()
    if (!rect) return band.startHour
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    return pxToHour(y, rect.height, band)
  }

  const handleDragOver = (e) => {
    if (!draggingVisit) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const hour = pointerToHour(e)
    // Micro-optimization: only push a new preview when the day or the
    // rounded hour actually changed. Avoids re-render on every mousemove px.
    if (!dropPreview || dropPreview.date !== date
        || Math.abs(dropPreview.startHour - hour) > 1e-6) {
      onColumnDragOver && onColumnDragOver({ date, startHour: hour })
    }
  }

  const handleDrop = (e) => {
    if (!draggingVisit) return
    e.preventDefault()
    const hour = pointerToHour(e)
    onColumnDrop && onColumnDrop(date, hour)
  }

  // Click-empty-slot to create. Only fire when the click landed on the body
  // itself (not on a bubbling block click), and only outside an existing
  // block's rect — VisitBlock's onClick calls stopPropagation, but the extra
  // check on `e.target === bodyRef.current` keeps us safe against ghosts.
  const handleBodyClick = (e) => {
    if (!onEmptySlot) return
    if (e.target !== bodyRef.current) return
    const hour = pointerToHour(e)
    const startTime = hourToTimeString(hour)
    const endTime = hourToTimeString(Math.min(23.983, hour + WEEK_GRID_CONSTANTS.DEFAULT_DURATION_HOURS))
    onEmptySlot(startTime, endTime)
  }

  const isDropTarget = dropPreview && dropPreview.date === date && draggingVisit
  const dropTopPct = isDropTarget
    ? (dropPreview.startHour - band.startHour) / (band.endHour - band.startHour)
    : 0

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

      {/* Hour-lined body — also the drag-drop target + click-empty-slot host.
          bodyRef gives us a stable rect for pointerToHour(). Clicks on
          existing blocks stopPropagation so they never fall through here. */}
      <div
        ref={bodyRef}
        data-testid={`week-grid-day-${date}`}
        className={`relative ${draggingVisit ? 'cursor-copy' : (onEmptySlot ? 'cursor-cell' : '')}`}
        style={{ height: gridHeightPx }}
        onDragOver={handleDragOver}
        onDragLeave={() => {/* keep the preview until we get a new dragover */}}
        onDrop={handleDrop}
        onClick={handleBodyClick}
      >
        {/* Drop preview: a translucent horizontal band showing where the
            dragged block would land. Height ~= dragged block's duration so
            the operator sees the actual footprint, not just a line. */}
        {isDropTarget && (() => {
          const duration = previewDurationHours(draggingVisit)
          const clampedStart = Math.min(band.endHour - duration, Math.max(band.startHour, dropPreview.startHour))
          const total = band.endHour - band.startHour
          const topPct = (clampedStart - band.startHour) / total
          const heightPct = duration / total
          return (
            <div
              className="absolute left-0.5 right-0.5 rounded-md bg-blue-500/20 border border-dashed border-blue-500 pointer-events-none z-10"
              style={{ top: `${topPct * 100}%`, height: `${heightPct * 100}%` }}
              data-testid="week-grid-drop-preview"
            />
          )
        })()}
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
              isDragging={draggingVisit?.id === v.id}
              onDragStart={onDragStartBlock}
              onDragEnd={onDragEndBlock}
            />
          )
        })}
      </div>
    </div>
  )
}

function VisitBlock({
  visit, jobs, properties, clients, empName, onOpen,
  topPct, heightPct, leftPct, widthPct, gridHeightPx,
  isDragging, onDragStart, onDragEnd,
}) {
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
    opacity: isDragging ? 0.4 : undefined,
  }

  const label = client?.name || property?.address || job?.title || 'Job'
  const timeLabel = formatTimeRange(visit.start_time, visit.end_time)

  const canDrag = !isCancelled && onDragStart
  return (
    <button
      type="button"
      draggable={canDrag ? true : undefined}
      onDragStart={canDrag ? (e) => {
        // Payload isn't needed — WeekGrid holds the dragging state in React —
        // but setting SOMETHING keeps Firefox happy and shows the copy cursor.
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', String(visit.id)) } catch { /* ignore */ }
        onDragStart(visit)
      } : undefined}
      onDragEnd={canDrag ? () => onDragEnd && onDragEnd() : undefined}
      className={`absolute rounded-md border shadow-sm text-left overflow-hidden transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500 ${cfg.pill} ${isCancelled ? 'opacity-50 line-through' : ''} ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={style}
      onClick={(e) => {
        // Stop the click bubbling into the day-column's empty-slot handler.
        e.stopPropagation()
        onOpen && onOpen(visit)
      }}
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

/**
 * The dragged block's height footprint, in hours. Used to size the drop
 * preview so the operator sees the actual landing rect, not just a line.
 * Falls back to the default 2h for untimed drags.
 */
function previewDurationHours(visit) {
  const s = parseTimeToHour(visit?.start_time)
  const e = parseTimeToHour(visit?.end_time)
  if (s != null && e != null && e > s) return e - s
  return WEEK_GRID_CONSTANTS.DEFAULT_DURATION_HOURS
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
