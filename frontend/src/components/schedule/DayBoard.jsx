/**
 * Desktop "Day" view — a read-only timeline of the day's work.
 *
 * This replaced the old dispatch board (the three-column drag-to-assign
 * surface) when the business moved to the subcontractor marketplace: the
 * office no longer assigns a cleaner to a job — a sub CLAIMS an open job and
 * the office approves (marketplace Rule 0, "the office never assigns"). So the
 * unassigned queue, the crew-capacity drop-columns, drag-to-assign, and the
 * "Auto-assign" button are gone. What a day still needs is to be *seen*: every
 * visit laid out by time, jobs with nobody on them showing as dashed "Needs
 * crew" blocks you tap to open (and post to the crew from there).
 *
 * Read-only on purpose: the timeline renders without the drag hooks, so a
 * block is a link to the job, not a thing you reassign here. Opening a job to
 * the crew lives on the job and the schedule tools; this view just shows the
 * day.
 */
import OpsSummary from './OpsSummary'
import DispatchTimeline from './DispatchTimeline'
import { toLocalYMD, todayYMD } from '../../utils/format'

export default function DayBoard({
  currentDate,
  todayVisits,
  todayStats,
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
      <div className="max-w-[1100px] mx-auto p-4">
        {/* Header — mirrors AgendaHero's hierarchy so mobile and desktop feel
            like one product. */}
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

        {/* The day, laid out by time. No drag hooks passed → read-only: a block
            is a tap-through to the job, never a reassign. A job with nobody on
            it shows as a dashed "Needs crew" block. */}
        <div className="mt-3">
          <DispatchTimeline
            visits={todayVisits}
            jobs={jobs}
            properties={properties}
            clients={clients}
            empName={empName}
            onOpen={onOpen}
          />
        </div>
      </div>
    </div>
  )
}
