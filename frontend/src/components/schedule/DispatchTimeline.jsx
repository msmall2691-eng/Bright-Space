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
 * without a crew get a dashed border in the job's type color and a plain
 * panel background instead of a filled color — the "Needs crew" line reads
 * in amber text so the cue doesn't rely on a tinted block, matching the
 * quiet hairline-card treatment UnassignedQueue uses for the same state.
 *
 * Each block is draggable — drop it on a crew card in CrewUtilization to
 * (re)assign that visit (see DispatchBoard's commitAssign).
 */
import { useEffect, useRef } from 'react'
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
  // Embedding hooks (both optional, both no-ops when omitted so the dispatch
  // board renders exactly as before). `className` is appended to the root so a
  // host can bound the height — the hour grid already scrolls internally, it
  // just needs a container that doesn't grow to the full 14-hour axis.
  // `scrollToHour` jumps that scroller to a given hour on mount, so a short
  // embedded box opens on the working part of the day instead of at 06:00.
  className = '', scrollToHour = null, hideHeader = false,
}) {
  const filtered = (visits || []).filter(v => v.status !== 'cancelled')
  const { total, positioned } = layoutColumns(filtered)

  const hourLabels = Array.from({ length: HOURS + 1 }, (_, i) => AXIS_START_HOUR + i)

  const scrollerRef = useRef(null)
  useEffect(() => {
    if (scrollToHour == null || !scrollerRef.current) return
    // One row of lead-in above the target hour so the block isn't flush
    // against the top edge. Clamped to the axis so an early/late hour can't
    // scroll past either end.
    const h = Math.min(AXIS_END_HOUR, Math.max(AXIS_START_HOUR, scrollToHour))
    scrollerRef.current.scrollTop = Math.max(0, (h - AXIS_START_HOUR - 1) * ROW_PX)
  }, [scrollToHour])

  return (
    <div className={`bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0 ${className}`}>
      {!hideHeader && (
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
            Today · {String(AXIS_START_HOUR).padStart(2, '0')}:00 – {String(AXIS_END_HOUR).padStart(2, '0')}:00
          </span>
          <span className="text-[11px] font-mono tabular-nums px-2 py-0.5 rounded-full border border-hairline bg-panel text-ink">
            {filtered.length}
          </span>
        </div>
      )}
      <div ref={scrollerRef} className="grid gap-2 flex-1 min-h-0 overflow-y-auto" style={{ gridTemplateColumns: '44px 1fr' }}>
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
                  unassigned ? 'bg-panel text-ink' : 'text-white'
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
                  <div className={`text-[10.5px] mt-0.5 truncate flex items-center gap-1 ${unassigned ? 'font-semibold text-amber-700 dark:text-amber-400' : 'opacity-90'}`}>
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
