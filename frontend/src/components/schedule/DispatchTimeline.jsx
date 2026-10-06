/**
 * A vertical hour-scale timeline of a day's jobs, positioned by start_time
 * and sized by duration. Used by the read-only Day view (DayBoard).
 *
 * Uses absolute positioning inside a lane column so overlapping jobs
 * split into left/right halves. Three or more overlapping visits pack
 * into ~one-third columns — same "let the density show" trade-off as
 * the horizontal route ribbon on mobile.
 *
 * Every block is a quiet panel card with a 3px left edge in the job's type
 * colour (`PROPERTY_TYPE_CONFIG.edge`), solid when a crew is assigned and
 * dashed when one isn't, so "needs crew" reads from the outline alone and the
 * "Needs crew" line repeats it in amber text — the cue never rests on colour.
 *
 * It used to be a saturated fill carrying white text, which the owner replaced
 * in Oct 2026 (BB-A11Y-02). That shape was also why the type colour could
 * never clear its contrast floor: one value had to be light enough to read as
 * a colour and dark enough to hold white text on it, and white on amber-500
 * was 1.9:1. A WeekGrid block is the same shape, so one job now reads the same
 * in both views.
 *
 * Drag-to-assign is gone with the old dispatch board (a sub is never
 * assigned — see the marketplace skill's Rule 0). The drag props are
 * retained but optional: pass none and blocks are static; tapping a block
 * opens the job. The component stays drag-capable only so a future
 * non-assigning reorder could reuse it.
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
            const color = PROPERTY_TYPE_CONFIG[type]?.edge || PROPERTY_TYPE_CONFIG.residential.edge
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
                // Quiet block, coloured left edge — the owner's call (Oct 2026),
                // and the same shape as a WeekGrid block, so one job reads the
                // same in both views. It used to be a saturated fill carrying
                // white text, which is why the type colour could never clear
                // its floor: one value had to be light enough to be a colour
                // and dark enough to hold white text, and white on amber-500
                // was 1.9:1. Ink on panel is the app's normal pair, and the
                // hue does what the design language asks of colour — a thin
                // signal, not a surface.
                className={`absolute rounded-lg text-left px-2 py-1.5 overflow-hidden border border-hairline bg-panel text-ink shadow-xs transition-shadow hover:shadow-md ${
                  onDragStartVisit ? 'cursor-grab active:cursor-grabbing' : ''
                }`}
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  left: `calc(${leftPct}% + 3px)`,
                  width: `calc(${widthPct}% - 6px)`,
                  // Dashed while nobody is assigned, so "needs crew" still
                  // reads at a glance from the block's outline alone.
                  borderLeft: `3px ${unassigned ? 'dashed' : 'solid'} ${color}`,
                }}
                title={`${start}${end ? ' – ' + end : ''} · ${blockLabel}${prop?.address && prop.address !== blockLabel ? ' · ' + prop.address : ''}${unassigned ? ' · needs crew' : crewLabel ? ' · ' + crewLabel : ''}${isDone ? ' · done' : ''}`}
              >
                <div className="text-[10.5px] font-mono tabular-nums text-ink-3 flex items-center gap-1">
                  {start}{end && ` – ${end}`}
                  {/* Worded/iconic "done" cue — a completed block otherwise looks
                      identical to a scheduled one (fill color is job type). */}
                  {isDone && <Check className="w-3 h-3 shrink-0" aria-label="Completed" />}
                </div>
                <div className="text-[12px] font-semibold tracking-tight leading-tight mt-0.5 truncate">
                  {blockLabel}
                </div>
                {(crewLabel || unassigned) && (
                  <div className={`text-[10.5px] mt-0.5 truncate flex items-center gap-1 ${unassigned ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-ink-3'}`}>
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
