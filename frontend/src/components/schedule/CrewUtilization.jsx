/**
 * Right column of the dispatch board — one card per cleaner, sorted by
 * hours worked today, with a utilization bar and a mini-list of stops.
 *
 * A crew at ≥90% capacity draws an amber bar (they're the ones you don't
 * want to hand another job to). Idle crews (0h) with capacity to spare
 * bubble to the bottom of the list with an "X.Xh open" chip so they read
 * as available to take unassigned work.
 *
 * Drop target for drag-assign: while a visit is being dragged (from
 * UnassignedQueue or DispatchTimeline), each card accepts a drop and hands
 * the crew id back to DispatchBoard's commitAssign. Highlights blue while
 * hovered so the operator sees exactly where it'll land.
 */
import { Users } from 'lucide-react'
import { cleanerInitials } from './constants'

const HOURS_PER_CREW_DAY = 8

const CREW_TONE = ['#3B82F6', '#22C55E', '#8B5CF6', '#F59E0B', '#EC4899', '#06B6D4']
const toneFor = (id) => {
  const s = String(id || '')
  let n = 0
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0
  return CREW_TONE[Math.abs(n) % CREW_TONE.length]
}

/** Availability chip for one crew for the board's date (crew app Phase 4):
 *  time off (amber) and weekly usually-off patterns (gray) come from
 *  /api/jobs/cleaner-availability; anyone absent from that payload is
 *  presumed available (green dot). Signals only — assignment never blocks. */
function AvailabilityChip({ info }) {
  if (info?.status === 'off') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300"
        title={info.detail}>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" /> Time off
      </span>
    )
  }
  if (info?.status === 'usually_off') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-3"
        title={info.detail}>
        <span className="w-1.5 h-1.5 rounded-full bg-ink-3/40 shrink-0" aria-hidden="true" /> {info.detail || 'Usually off'}
      </span>
    )
  }
  if (info?.status === 'unavailable') {
    /* Explicit week entry (Phase 4b) — firmer than the gray usually-off,
       distinct from the amber time-off cue. */
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-700 dark:text-red-300"
        title={info.detail}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" /> Unavailable
      </span>
    )
  }
  if (info?.status === 'conflict' || info?.status === 'same_day') return null  // the bar shows load
  if (info?.status) return null  // unknown future status: no chip, never a false green
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
      title="No time off or pattern says available">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Available
    </span>
  )
}

export default function CrewUtilization({
  crewLoad, availability = {}, empName, draggingVisit, dragOverCrewId, onDragOverCrew, onDropCrew,
}) {
  if (!crewLoad || crewLoad.length === 0) {
    // Previously rendered nothing at all here, leaving the dispatch board's
    // third column blank — a brand-new org (no crew roster yet) or a day
    // with zero jobs saw a lopsided 2-column layout that read as broken
    // rather than "nothing to show yet".
    return (
      <div className="bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
            Crews
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
          <Users className="w-6 h-6 text-ink-3 mb-2" />
          <p className="text-[13px] text-ink">No crew roster yet</p>
          <p className="text-[11.5px] text-ink-3 mt-0.5">
            Add your cleaners on the Crew page to see crew capacity here.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
          Crews
        </span>
        <span className="text-[11px] font-mono tabular-nums px-2 py-0.5 rounded-full border border-hairline bg-panel text-ink">
          {crewLoad.filter(c => c.hours > 0).length}
        </span>
      </div>

      <ul className="space-y-2 overflow-y-auto flex-1">
        {crewLoad.map(crew => {
          const name = empName?.(crew.id) || 'Cleaner'
          const initials = cleanerInitials(name)
          const tone = toneFor(crew.id)
          const isHigh = crew.capacityPct >= 90
          const isIdle = crew.hours === 0
          const openHours = Math.max(0, HOURS_PER_CREW_DAY - crew.hours)
          const isDropTarget = !!draggingVisit && dragOverCrewId === crew.id
          return (
            <li
              key={crew.id}
              data-testid={`crew-card-${crew.id}`}
              onDragOver={draggingVisit ? (e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dragOverCrewId !== crew.id) onDragOverCrew?.(crew.id)
              } : undefined}
              onDragLeave={draggingVisit ? () => {
                if (dragOverCrewId === crew.id) onDragOverCrew?.(null)
              } : undefined}
              onDrop={draggingVisit ? (e) => { e.preventDefault(); onDropCrew?.(crew.id) } : undefined}
              className={`bg-panel border rounded-xl p-3 transition-colors ${
                isDropTarget ? 'border-blue-400 ring-2 ring-blue-400/40 bg-blue-50/40' : 'border-hairline'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-6 h-6 rounded-full grid place-items-center text-[10.5px] font-bold text-white shrink-0"
                    style={{ background: tone }}
                  >
                    {initials}
                  </span>
                  <span className="text-[13px] font-semibold text-ink tracking-tight truncate">
                    {name}
                  </span>
                </div>
                <span className="text-[10.5px] font-mono tabular-nums text-ink-3 shrink-0">
                  {crew.hours}h · {crew.capacityPct}%
                </span>
              </div>
              <div className="mt-1.5">
                <AvailabilityChip info={availability[String(crew.id)]} />
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-bg-2 relative overflow-hidden">
                <span
                  className={`absolute top-0 left-0 h-full rounded-full ${
                    isHigh ? 'bg-amber-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${crew.capacityPct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {crew.visits.slice(0, 3).map(v => (
                  <span
                    key={v.id}
                    className="text-[10px] font-mono tabular-nums text-ink-3 border border-hairline bg-bg-2 rounded px-1.5 py-0.5"
                  >
                    {(v.start_time || '').slice(0, 5)}
                  </span>
                ))}
                {isIdle && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-700 dark:text-amber-300 border border-hairline bg-bg-2 rounded px-1.5 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                    {openHours}h open
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
