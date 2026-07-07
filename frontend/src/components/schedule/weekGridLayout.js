/**
 * Pure layout helpers for the WeekGrid time-grid view. Kept separate from
 * the component so the tricky bits (time parsing, overlap → column-index
 * assignment, hour-band auto-expand) are unit-testable without a DOM.
 *
 * Nothing here reads state or the DOM.
 */

const DEFAULT_HOUR_START = 7
const DEFAULT_HOUR_END = 19    // exclusive upper bound (07:00–19:00)
const HARD_MIN_HOUR = 5
const HARD_MAX_HOUR = 22
const DEFAULT_DURATION_HOURS = 2

/**
 * Parse an "HH:MM" (or "HH:MM:SS") string into a float hour value.
 * Returns null for missing / unparseable / out-of-range input.
 */
export function parseTimeToHour(time) {
  if (!time) return null
  const s = String(time).trim()
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h + min / 60
}

/**
 * Given an array of jobs (each with optional start_time / end_time), decide
 * the visible hour band. Defaults to 07:00–19:00 but expands so the earliest
 * start and latest end fit, clamped to 05:00–22:00. Untimed jobs are
 * ignored — they go in the "unscheduled time" strip instead of stretching
 * the band. Returns {startHour, endHour} where endHour is EXCLUSIVE.
 */
export function computeHourBand(jobs) {
  let earliest = DEFAULT_HOUR_START
  let latest = DEFAULT_HOUR_END
  for (const j of jobs || []) {
    const s = parseTimeToHour(j.start_time)
    if (s == null) continue
    const e = parseTimeToHour(j.end_time)
    const end = e != null && e > s ? e : s + DEFAULT_DURATION_HOURS
    if (s < earliest) earliest = s
    if (end > latest) latest = end
  }
  const startHour = Math.max(HARD_MIN_HOUR, Math.min(DEFAULT_HOUR_START, Math.floor(earliest)))
  const endHour   = Math.min(HARD_MAX_HOUR, Math.max(DEFAULT_HOUR_END, Math.ceil(latest)))
  return { startHour, endHour }
}

/**
 * Turn a start_hour/end_hour pair and the visible hour band into a top/height
 * position as fractions of the total grid height (0..1). The component
 * multiplies these by its actual pixel height.
 * If the block extends past the visible band, clip it (still show inside).
 */
export function positionForBlock(startHour, endHour, band) {
  const total = band.endHour - band.startHour
  if (total <= 0) return { topPct: 0, heightPct: 0, clipped: true }
  const s = Math.max(band.startHour, startHour)
  const e = Math.min(band.endHour, endHour)
  if (e <= s) return { topPct: 0, heightPct: 0, clipped: true }
  return {
    topPct: (s - band.startHour) / total,
    heightPct: (e - s) / total,
    clipped: startHour < band.startHour || endHour > band.endHour,
  }
}

/**
 * Compute a horizontal layout for a set of jobs that all live in the same
 * day column. Overlapping jobs are packed into side-by-side lanes using the
 * standard calendar overlap algorithm: sort by start, then assign each job
 * to the leftmost lane where it doesn't overlap the previous occupant.
 *
 * Returns an array of the same length as `jobs`, each entry:
 *   { jobId, laneIndex, laneCount, startHour, endHour }
 * where laneCount is the TOTAL number of overlapping lanes in the block
 * containing this job (so widthPct = 1/laneCount, leftPct = laneIndex/laneCount).
 *
 * Jobs without a resolvable start time are dropped from the timed layout
 * (the caller renders them in the "unscheduled time" strip).
 */
export function layoutDayColumn(jobs) {
  const timed = []
  for (const j of jobs || []) {
    const s = parseTimeToHour(j.start_time)
    if (s == null) continue
    const e = parseTimeToHour(j.end_time)
    const endHour = e != null && e > s ? e : s + DEFAULT_DURATION_HOURS
    timed.push({ jobId: j.id, startHour: s, endHour })
  }
  timed.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour)

  // Greedy lane assignment. `lanes` = array of lane end-times; a new job
  // slots into the first lane whose current end <= its start.
  const lanes = []
  const assigned = timed.map(t => {
    let li = lanes.findIndex(end => end <= t.startHour + 1e-9)
    if (li === -1) {
      lanes.push(t.endHour)
      li = lanes.length - 1
    } else {
      lanes[li] = t.endHour
    }
    return { ...t, laneIndex: li }
  })

  // Group overlapping jobs into "blocks" — a block is a maximal run of jobs
  // where each consecutive pair shares at least one lane time. Within a
  // block every job shares the same laneCount so widths line up cleanly.
  // Simpler correct approximation: sweep, and when a new job starts strictly
  // after the max end seen so far, close the block.
  const laneCounts = new Array(assigned.length).fill(1)
  let blockStart = 0
  let blockMaxEnd = -Infinity
  let blockLaneMax = 0
  const flush = (endIdx) => {
    for (let k = blockStart; k < endIdx; k++) laneCounts[k] = Math.max(blockLaneMax, 1)
    blockStart = endIdx
    blockMaxEnd = -Infinity
    blockLaneMax = 0
  }
  for (let i = 0; i < assigned.length; i++) {
    const a = assigned[i]
    if (a.startHour >= blockMaxEnd - 1e-9 && i !== blockStart) {
      flush(i)
    }
    blockMaxEnd = Math.max(blockMaxEnd, a.endHour)
    blockLaneMax = Math.max(blockLaneMax, a.laneIndex + 1)
  }
  flush(assigned.length)

  return assigned.map((a, i) => ({
    jobId: a.jobId,
    laneIndex: a.laneIndex,
    laneCount: laneCounts[i],
    startHour: a.startHour,
    endHour: a.endHour,
  }))
}

/**
 * Convenience: split a bag of same-day jobs into { timed, untimed }.
 * Untimed = start_time is null / unparseable — those render in the top strip.
 */
export function splitTimedUntimed(jobs) {
  const timed = []
  const untimed = []
  for (const j of jobs || []) {
    if (parseTimeToHour(j.start_time) == null) untimed.push(j)
    else timed.push(j)
  }
  return { timed, untimed }
}

/**
 * Return the 7 days of the week (Sun–Sat) that contain the given local date,
 * as YYYY-MM-DD strings. Mirrors what useScheduleData already keys its fetch
 * on so the WeekGrid can render the same window without a second call.
 */
export function weekDaysContaining(date) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  const dow = d.getDay()          // 0 = Sun
  d.setDate(d.getDate() - dow)
  const out = []
  for (let i = 0; i < 7; i++) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export const WEEK_GRID_CONSTANTS = {
  DEFAULT_HOUR_START,
  DEFAULT_HOUR_END,
  HARD_MIN_HOUR,
  HARD_MAX_HOUR,
  DEFAULT_DURATION_HOURS,
}
