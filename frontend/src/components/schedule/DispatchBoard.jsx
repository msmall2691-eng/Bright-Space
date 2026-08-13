/**
 * Desktop dispatch board — three columns that answer the three questions
 * a dispatcher asks in the morning:
 *
 *   Left    · Which jobs still need a crew?         (UnassignedQueue)
 *   Center  · What does today look like in time?    (DispatchTimeline)
 *   Right   · Who's got capacity to take work on?   (CrewUtilization)
 *
 * Below the columns, an ops-summary chip strip echoes the mobile hero's
 * top-line numbers so the desktop reads consistently. On narrow desktop
 * viewports (≤ md) the grid collapses to a single stack so the layout
 * never asks the operator to scroll horizontally to see one panel.
 *
 * Drag-assign: dragging a visit card out of UnassignedQueue or a block out
 * of DispatchTimeline and dropping it on a crew card in CrewUtilization
 * assigns that visit to that one cleaner (replacing whoever else was on
 * it — a drag onto a crew card reads as "put this job on THEM", not "add
 * them too"). Mirrors WeekGrid's optimistic-commit + 409-conflict-retry
 * pattern, just PATCHing cleaner_ids instead of scheduled_date/start/end.
 */
import { useState, useCallback } from 'react'
import { patch } from '../../api'
import OpsSummary from './OpsSummary'
import UnassignedQueue from './UnassignedQueue'
import DispatchTimeline from './DispatchTimeline'
import CrewUtilization from './CrewUtilization'
import { toLocalYMD, todayYMD } from '../../utils/format'

// Which board columns are showing — persisted so a half-screen operator who
// hides Unassigned to give the timeline room finds it hidden tomorrow too.
// (Owner request, Aug 2026: "I wish I could collapse some parts".)
const COLS_KEY = 'bb_dispatch_cols'
const DEFAULT_COLS = { unassigned: true, timeline: true, crews: true }

function loadCols() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) || 'null')
    if (raw && typeof raw === 'object') return { ...DEFAULT_COLS, ...raw }
  } catch { /* ignore */ }
  return { ...DEFAULT_COLS }
}

export default function DispatchBoard({
  currentDate,
  todayVisits,
  todayStats,
  unassignedToday,
  crewLoad,
  crewAvailability = {},
  jobs,
  properties,
  clients,
  empName,
  onOpen,
  onLocalMove,
  toast,
}) {
  const dateStr = toLocalYMD(currentDate)
  const isToday = dateStr === todayYMD()
  const label = new Date(`${dateStr}T00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  const [draggingVisit, setDraggingVisit] = useState(null)
  const [dragOverCrewId, setDragOverCrewId] = useState(null)
  const [cols, setCols] = useState(loadCols)
  const toggleCol = useCallback((key) => {
    setCols(prev => {
      const shown = Object.values(prev).filter(Boolean).length
      // Never allow hiding the last visible column — a fully blank board
      // reads as broken, and there'd be nothing left to click.
      if (prev[key] && shown <= 1) return prev
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem(COLS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const commitAssign = useCallback(async (visit, crewId, opts = {}) => {
    const { allowConflicts = false, isRetry = false } = opts
    const jobId = visit.job_id ?? visit.id
    const original = { cleaner_ids: visit.cleaner_ids || [] }
    const next = { cleaner_ids: [crewId] }
    const wasUnassigned = original.cleaner_ids.length === 0
    const crewName = empName?.(crewId) || 'this cleaner'

    onLocalMove?.(jobId, next)
    try {
      await patch(`/api/jobs/${jobId}`, {
        cleaner_ids: next.cleaner_ids,
        ...(allowConflicts ? { allow_conflicts: true } : {}),
      })
      if (isRetry) toast?.success('Assigned with conflict override')
      else toast?.success(`${wasUnassigned ? 'Assigned to' : 'Reassigned to'} ${crewName}`)
    } catch (err) {
      const status = err && (err.status || err.statusCode)
      const detail = (err && (err.detail || err.message)) || ''
      onLocalMove?.(jobId, original)
      if (status === 409 && toast) {
        toast.error(
          `Can't assign: ${detail.slice(0, 160) || 'scheduling conflict'}`,
          {
            action: {
              label: 'Assign anyway',
              onClick: () => commitAssign(visit, crewId, { allowConflicts: true, isRetry: true }),
            },
          },
        )
      } else if (toast) {
        toast.error(`Assignment failed${detail ? ': ' + detail.slice(0, 160) : ''}`)
      } else {
        console.error('[DispatchBoard] Assign failed:', err)
      }
    }
  }, [onLocalMove, toast, empName])

  const handleDropOnCrew = useCallback((crewId) => {
    setDragOverCrewId(null)
    const visit = draggingVisit
    setDraggingVisit(null)
    if (!visit) return
    const current = visit.cleaner_ids || []
    if (current.length === 1 && current[0] === crewId) return // no-op: dropped on its own crew
    commitAssign(visit, crewId)
  }, [draggingVisit, commitAssign])

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-[1400px] mx-auto p-4">
        {/* Header — mirrors AgendaHero's typographic hierarchy so mobile
            and desktop feel like the same product. */}
        <div className="mb-4">
          {isToday && (
            <div className="text-[10px] font-mono tracking-widest uppercase text-ink-3 mb-0.5">
              Today
            </div>
          )}
          <h2 className="text-[28px] font-bold text-ink tracking-tight leading-tight">
            {label}
          </h2>
        </div>

        <OpsSummary stats={todayStats} isToday={false} />

        {/* Column toggles — collapse what you don't need so the timeline
            gets the room on a half-width window. Persisted; the last
            visible column can't be hidden. */}
        <div className="flex items-center gap-1.5 mt-2">
          {[
            ['unassigned', `Unassigned${unassignedToday?.length ? ` (${unassignedToday.length})` : ''}`],
            ['timeline', 'Timeline'],
            ['crews', `Crews${crewLoad?.length ? ` (${crewLoad.length})` : ''}`],
          ].map(([key, label]) => (
            <button key={key} onClick={() => toggleCol(key)} aria-pressed={cols[key]}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                cols[key]
                  ? 'bg-panel border-hairline text-ink'
                  : 'bg-bg-2 border-transparent text-ink-3 line-through decoration-ink-3/50 hover:text-ink-2'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* The board — only the visible columns render, and the grid template
            is computed from them (the timeline always takes the flexible
            track). The old <900px single-stack media query is gone: below
            1100px the Day tab renders the agenda layout instead, so this
            board never has to squeeze. */}
        <div
          className="grid gap-3 mt-2"
          style={{
            gridTemplateColumns: [
              cols.unassigned && 'minmax(240px, 300px)',
              cols.timeline && 'minmax(0, 1fr)',
              cols.crews && 'minmax(260px, 320px)',
            ].filter(Boolean).join(' ') || '1fr',
          }}
        >
          {cols.unassigned && (
            <UnassignedQueue
              visits={unassignedToday}
              jobs={jobs}
              properties={properties}
              clients={clients}
              onOpen={onOpen}
              onDragStartVisit={setDraggingVisit}
              onDragEndVisit={() => setDraggingVisit(null)}
            />
          )}
          {cols.timeline && (
            <DispatchTimeline
              visits={todayVisits}
              jobs={jobs}
              properties={properties}
              clients={clients}
              empName={empName}
              onOpen={onOpen}
              onDragStartVisit={setDraggingVisit}
              onDragEndVisit={() => setDraggingVisit(null)}
            />
          )}
          {cols.crews && (
            <CrewUtilization
              crewLoad={crewLoad}
              availability={crewAvailability}
              empName={empName}
              draggingVisit={draggingVisit}
              dragOverCrewId={dragOverCrewId}
              onDragOverCrew={setDragOverCrewId}
              onDropCrew={handleDropOnCrew}
            />
          )}
        </div>
      </div>
    </div>
  )
}
