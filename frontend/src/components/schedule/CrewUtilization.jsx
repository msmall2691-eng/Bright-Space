/**
 * Right column of the dispatch board — one card per cleaner, sorted by
 * hours worked today, with a utilization bar and a mini-list of stops.
 *
 * A crew at ≥90% capacity draws an amber bar (they're the ones you don't
 * want to hand another job to). Idle crews (0h) with capacity to spare
 * bubble to the bottom of the list with an "X.Xh open" chip so they read
 * as available to take unassigned work.
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

export default function CrewUtilization({ crewLoad, empName }) {
  if (!crewLoad || crewLoad.length === 0) {
    // Previously rendered nothing at all here, leaving the dispatch board's
    // third column blank — a brand-new org (no Connecteam roster yet) or a
    // day with zero jobs saw a lopsided 2-column layout that read as broken
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
            Connect Connecteam in Settings to see crew capacity here.
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
          return (
            <li key={crew.id} className="bg-panel border border-hairline rounded-xl p-3">
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
                  <span className="text-[10px] font-mono text-amber-700 border border-amber-200 bg-amber-50 rounded px-1.5 py-0.5">
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
