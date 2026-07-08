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
 */
import OpsSummary from './OpsSummary'
import UnassignedQueue from './UnassignedQueue'
import DispatchTimeline from './DispatchTimeline'
import CrewUtilization from './CrewUtilization'
import { toLocalYMD, todayYMD } from '../../utils/format'

export default function DispatchBoard({
  currentDate,
  todayVisits,
  todayStats,
  unassignedToday,
  crewLoad,
  jobs,
  properties,
  clients,
  empName,
  onOpen,
}) {
  const dateStr = toLocalYMD(currentDate)
  const isToday = dateStr === todayYMD()
  const label = new Date(`${dateStr}T00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

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

        {/* Three-column board — collapses to a single stack on narrower
            viewports via the media-query rule below. Inline style would
            override that override, so the layout lives in a class. */}
        <div className="dispatch-board-grid gap-3 mt-2">
          <UnassignedQueue
            visits={unassignedToday}
            jobs={jobs}
            properties={properties}
            clients={clients}
            onOpen={onOpen}
          />
          <DispatchTimeline
            visits={todayVisits}
            jobs={jobs}
            properties={properties}
            clients={clients}
            empName={empName}
            onOpen={onOpen}
          />
          <CrewUtilization crewLoad={crewLoad} empName={empName} />
        </div>

        <style>{`
          .dispatch-board-grid {
            display: grid;
            grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) minmax(260px, 320px);
          }
          @media (max-width: 900px) {
            .dispatch-board-grid {
              grid-template-columns: 1fr;
            }
          }
        `}</style>
      </div>
    </div>
  )
}
