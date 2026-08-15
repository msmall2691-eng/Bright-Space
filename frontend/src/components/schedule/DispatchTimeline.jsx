/**
 * Center column of the dispatch board — a vertical hour-scale timeline
 * with today's jobs positioned by start_time and sized by duration.
 *
 * Uses absolute positioning inside a lane column so overlapping jobs
 * split into left/right halves. Three or more overlapping visits pack
 * into ~one-third columns — same "let the density show" trade-off as
 * the horizontal route ribbon on mobile.
 *
 * Type color drives the block fill (matches PROPERTY_TYPE_CONFIG). Blocks
 * without a crew get a dashed amber border, no fill — same convention as
 * the route ribbon so unassigned reads the same across views.
 *
 * Each block is draggable — drop it on a crew card in CrewUtilization to
 * (re)assign that visit (see DispatchBoard's commitAssign).
 */
import { Check } from 'lucide-react'
import { PROPERTY_TYPE_CONFIG } from './constants'

const AXIS_START_HOUR = 6
const AXIS_END_HOUR = 20
const HOURS = AXIS_END_HOUR - AXIS_START_HOUR
const ROW_PX = 48 // one hour cell height

const parseHHMM = (s) => {
  if (!s) return null
  const [h, m] = String(s).slice(0, 5).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h + m / 60
}

function layoutColumns(visits) {
  // Assign each visit a column so overlapping ones don't stack. Greedy:
  // pick the first column whose latest end is <= this visit's start.
  const columns = []
  const positioned = []
  const sorted = [...visits].sort((a, b) => {
    const as = parseHHMM(a.start_time) ?? 24
    const bs = parseHHMM(b.start_time) ?? 24
    return as - bs
  })
  for (const v of sorted) {
    const s = parseHHMM(v.start_time)
    const e = parseHHMM(v.end_time)
    if (s == null || e == null || e <= s) continue
    let col = columns.findIndex(endTime => endTime <= s)
    if (col === -1) {
      col = columns.length
      columns.push(e)
    } else {
      columns[col] = e
    }
    positioned.push({ v, col, s, e })
  }
  const total = Math.max(1, columns.length)
  return { total, positioned }
}

export default function DispatchTimeline({
  visits, jobs, properties, clients, empName, onOpen, onDragStartVisit, onDragEndVisit,
}) {
  const filtered = (visits || []).filter(v => v.status !== 'cancelled')
  const { total, positioned } = layoutColumns(filtered)

  const hourLabels = Array.from({ length: HOURS + 1 }, (_, i) => AXIS_START_HOUR + i)

  return (
    <div className="bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
          Today · {String(AXIS_START_HOUR).padStart(2, '0')}:00 – {String(AXIS_END_HOUR).padStart(2, '0')}:00
        </span>
        <span className="text-[11px] font-mono tabular-nums px-2 py-0.5 rounded-full border border-hairline bg-panel text-ink">
          {filtered.length}
        </span>
      </div>
      <div className="grid gap-2 flex-1 overflow-y-auto" style={{ gridTemplateColumns: '44px 1fr' }}>
        {/* Hour column */}
        <div className="relative" style={{ height: `${HOURS * ROW_PX}px` }}>
          {hourLabels.map(h => (
            <div
              key={h}
              className="absolute right-2 text-[10.5px] font-mono tabular-nums text-ink-3"
              style={{ top: `${(h - AXIS_START_HOUR) * ROW_PX}px`, transform: 'translateY(-6px)' }}
            >
              {String(h).padStart(2, '0')}
            </div>
          ))}
        </div>

        {/* Lane column */}
        <div className="relative" style={{ height: `${HOURS * ROW_PX}px` }}>
          {/* Hour lines */}
          {hourLabels.map(h => (
            <div
              key={h}
              className="absolute left-0 right-0 border-t border-dashed border-hairline"
              style={{ top: `${(h - AXIS_START_HOUR) * ROW_PX}px` }}
            />
          ))}

          {/* Blocks */}
          {positioned.map(({ v, col, s, e }) => {
            const job = jobs[v.job_id]
            const prop = properties[job?.property_id]
            const client = clients[job?.client_id]
            const type = prop?.property_type || job?.job_type || 'residential'
            const unassigned = (v.cleaner_ids?.length || 0) === 0
            const top = (s - AXIS_START_HOUR) * ROW_PX
            const height = Math.max(30, (e - s) * ROW_PX - 2)
            const widthPct = 100 / total
            const leftPct = col * widthPct
            const color = PROPERTY_TYPE_CONFIG[type]?.hex || PROPERTY_TYPE_CONFIG.residential.hex
            const start = (v.start_time || '').slice(0, 5)
            const end = (v.end_time || '').slice(0, 5)
            const crewLabel = (v.cleaner_ids || [])
              .map(id => empName?.(id))
              .filter(Boolean)
              .slice(0, 2)
              .join(' + ')
            const isDone = v.status === 'completed'
            const blockLabel = client?.name || job?.title || `Visit ${v.id}`
            return (
              <button
                key={v.id}
                type="button"
                draggable={!!onDragStartVisit}
                onDragStart={onDragStartVisit ? (e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', String(v.id)) } catch { /* ignore */ }
                  onDragStartVisit(v)
                } : undefined}
                onDragEnd={onDragEndVisit}
                onClick={() => onOpen?.(v, job, prop)}
                className={`absolute rounded-lg text-left px-2 py-1.5 overflow-hidden transition-shadow hover:shadow-md ${
                  unassigned ? 'bg-amber-50 text-amber-900' : 'text-white'
                } ${onDragStartVisit ? 'cursor-grab active:cursor-grabbing' : ''}`}
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  left: `calc(${leftPct}% + 3px)`,
                  width: `calc(${widthPct}% - 6px)`,
                  background: unassigned ? undefined : color,
                  border: unassigned ? `1.5px dashed ${color}` : `1px solid rgba(0,0,0,0.08)`,
                }}
                title={`${start}${end ? ' – ' + end : ''} · ${blockLabel}${prop?.address && prop.address !== blockLabel ? ' · ' + prop.address : ''}${unassigned ? ' · needs crew' : crewLabel ? ' · ' + crewLabel : ''}${isDone ? ' · done' : ''}`}
              >
                <div className="text-[10.5px] font-mono tabular-nums opacity-90 flex items-center gap-1">
                  {start}{end && ` – ${end}`}
                  {/* Worded/iconic "done" cue — a completed block otherwise looks
                      identical to a scheduled one (fill color is job type). */}
                  {isDone && <Check className="w-3 h-3 shrink-0" aria-label="Completed" />}
                </div>
                <div className="text-[12px] font-semibold tracking-tight leading-tight mt-0.5 truncate">
                  {blockLabel}
                </div>
                {(crewLabel || unassigned) && (
                  <div className={`text-[10.5px] mt-0.5 truncate flex items-center gap-1 ${unassigned ? 'font-semibold' : 'opacity-90'}`}>
                    <span className="truncate">{unassigned ? 'Needs crew' : crewLabel}</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
