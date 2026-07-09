/**
 * Route ribbon — the shape of the day, read left-to-right.
 *
 * A 6am → 8pm axis with each visit as a colored block sized by duration
 * and colored by service type. Dashed blocks are unassigned. Vertical
 * stacking is naive (row 0 vs row 1) — two overlapping jobs get one row
 * each so you can see the overlap without the layout algorithm becoming
 * a whole thing. Three or more overlaps stack visually beyond the ribbon
 * height, which is fine as a signal ("this hour is busy — go check the
 * agenda").
 */
import { PROPERTY_TYPE_CONFIG } from './constants'

const AXIS_START_HOUR = 6
const AXIS_END_HOUR = 20 // exclusive upper bound for display, block edges can go slightly past 20
const AXIS_HOURS = AXIS_END_HOUR - AXIS_START_HOUR // 14

const parseHHMM = (s) => {
  if (!s) return null
  const [h, m] = String(s).slice(0, 5).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h + m / 60
}

export default function RouteRibbon({ visits, jobs, properties }) {
  const blocks = (visits || [])
    .map(v => {
      const start = parseHHMM(v.start_time)
      const end = parseHHMM(v.end_time)
      if (start == null || end == null) return null
      const clampedStart = Math.max(AXIS_START_HOUR, start)
      const clampedEnd = Math.min(AXIS_END_HOUR, end)
      if (clampedEnd <= clampedStart) return null
      const job = jobs[v.job_id]
      const prop = properties[job?.property_id]
      const type = prop?.property_type || job?.job_type || 'residential'
      const unassigned = (v.cleaner_ids?.length || 0) === 0 && v.status !== 'completed'
      return {
        id: v.id,
        left: ((clampedStart - AXIS_START_HOUR) / AXIS_HOURS) * 100,
        width: ((clampedEnd - clampedStart) / AXIS_HOURS) * 100,
        type,
        unassigned,
        start,
      }
    })
    .filter(Boolean)

  // Two-row layout: a greedy pass places each block on the first row it
  // fits. A block that overlaps every existing row goes on row 1 (so a
  // dense hour visibly stacks — enough signal without solving true
  // interval-graph coloring).
  const rows = [[], []]
  const placed = blocks
    .sort((a, b) => a.start - b.start)
    .map(b => {
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]
        const collides = row.some(x => !(b.left + b.width <= x.left || x.left + x.width <= b.left))
        if (!collides) {
          row.push(b)
          return { ...b, row: r }
        }
      }
      // Fallback: pack onto row 1 even if it collides. The visible clash
      // is the signal.
      rows[1].push(b)
      return { ...b, row: 1 }
    })

  if (placed.length === 0) return null

  // Even hour ticks — 6a, 8a, 10a, 12p, 2p, 4p, 6p — same rhythm as a
  // flight departure board (odd hours skipped so labels don't crowd).
  const ticks = []
  for (let h = AXIS_START_HOUR; h < AXIS_END_HOUR; h += 2) {
    ticks.push({ h, left: ((h - AXIS_START_HOUR) / AXIS_HOURS) * 100 })
  }

  const totalStops = visits.filter(v => v.status !== 'cancelled').length
  const unassignedCount = placed.filter(b => b.unassigned).length

  return (
    <div className="mx-3 mb-3">
      <div className="bg-bg-2 border border-hairline rounded-2xl p-3">
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
            Route · {String(AXIS_START_HOUR).padStart(2, '0')}:00 – {String(AXIS_END_HOUR).padStart(2, '0')}:00
          </span>
          <span className="text-[10px] font-mono text-ink-3 tabular-nums">
            {totalStops} stop{totalStops === 1 ? '' : 's'}
            {unassignedCount > 0 && ` · ${unassignedCount} unassigned`}
          </span>
        </div>
        <div className="relative h-11 mb-1">
          {/* Hour grid */}
          <div className="absolute inset-0 pointer-events-none">
            {ticks.map(t => (
              <div
                key={t.h}
                className="absolute top-0 bottom-0 border-l border-dashed border-hairline"
                style={{ left: `${t.left}%` }}
              />
            ))}
          </div>
          {/* Blocks */}
          {placed.map(b => (
            <div
              key={b.id}
              className="absolute rounded-[5px]"
              style={{
                left: `${b.left}%`,
                width: `${b.width}%`,
                top: b.row === 0 ? '2px' : '22px',
                height: '18px',
                background: b.unassigned ? 'transparent' : (PROPERTY_TYPE_CONFIG[b.type]?.hex || PROPERTY_TYPE_CONFIG.residential.hex),
                border: b.unassigned
                  ? `1.5px dashed ${PROPERTY_TYPE_CONFIG[b.type]?.hex || PROPERTY_TYPE_CONFIG.str.hex}`
                  : 'none',
                boxShadow: b.unassigned ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.15)',
              }}
              aria-label={`${b.type} visit${b.unassigned ? ', unassigned' : ''}`}
            />
          ))}
        </div>
        {/* Tick labels */}
        <div className="relative h-3">
          {ticks.map(t => (
            <span
              key={t.h}
              className="absolute text-[9px] font-mono text-ink-3 tabular-nums"
              style={{ left: `${t.left}%` }}
            >
              {t.h === 12 ? '12p' : t.h < 12 ? `${t.h}a` : `${t.h - 12}p`}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
