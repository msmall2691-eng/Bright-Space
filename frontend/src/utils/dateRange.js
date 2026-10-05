/**
 * Pure date-range helpers shared by useScheduleData and CalendarView so
 * both derive the same "what does this view need to fetch" answer from
 * `currentDate`. Audit §16 — the two used to compute independent ranges
 * (week Sun–Sat for useScheduleData, calendar-month for CalendarView),
 * which is how the health strip stats could disagree with what the month
 * grid showed.
 *
 * All functions accept a Date or a Date-parseable string and return
 * plain YYYY-MM-DD strings so they're timezone-inert.
 */

function toYMD(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Sunday–Saturday of the week containing `date`. */
export function weekRange(date) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  const start = toYMD(d)
  d.setDate(d.getDate() + 6)
  const end = toYMD(d)
  return { start, end }
}

/**
 * The month's calendar-grid range: from the first Sunday on-or-before
 * the 1st of the month, through the last Saturday on-or-after the last
 * day of the month (so 35 or 42 days total — same window
 * CalendarView.jsx already renders as its 5- or 6-row grid).
 */
export function monthGridRange(date) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  const year = d.getFullYear()
  const month = d.getMonth()
  const firstOfMonth = new Date(year, month, 1, 12, 0, 0, 0)
  const gridStart = new Date(firstOfMonth)
  gridStart.setDate(firstOfMonth.getDate() - firstOfMonth.getDay())      // first Sunday
  const lastOfMonth = new Date(year, month + 1, 0, 12, 0, 0, 0)
  const gridEnd = new Date(lastOfMonth)
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()))    // last Saturday
  return { start: toYMD(gridStart), end: toYMD(gridEnd) }
}

/**
 * The range useScheduleData should ask the API for, given the caller's
 * view mode. Agenda + week are day-level views over one week; month
 * covers the whole grid so a single fetch feeds both the health strip
 * (which clips to the current week for "This week" stats) and the
 * month grid.
 */
export function rangeForView(currentDate, viewMode) {
  if (viewMode === 'month') return monthGridRange(currentDate)
  return weekRange(currentDate)
}

/**
 * Every calendar day from `start` to `end` inclusive, as YYYY-MM-DD.
 *
 * For turning a range that was already FETCHED into the day keys a per-day
 * summary needs — the dashboard's week rail groups one week's visits by
 * `scheduled_date` and needs all seven keys, including the days with nothing
 * on them (a day the business is closed is a real answer, and deriving the
 * keys from the visits alone would silently drop it).
 *
 * Parsed at noon for the reason the helpers above are: midnight plus a DST
 * shift lands on the previous day in half the world's timezones.
 */
export function daysInRange(start, end) {
  if (!start || !end || start > end) return []
  const [y, m, d] = start.split('-').map(Number)
  const cur = new Date(y, m - 1, d, 12, 0, 0, 0)
  const out = []
  // Bounded so a malformed pair can never spin: a fetched range is a week or
  // a month grid, never a year.
  for (let i = 0; i < 400; i++) {
    const ymd = toYMD(cur)
    if (ymd > end) break
    out.push(ymd)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/**
 * Does the outer range fully contain the inner one? Used by CalendarView
 * to decide whether the parent's fetched jobs cover its month grid; if
 * yes, it can skip its own jobs fetch (audit §16).
 */
export function rangeContains(outer, inner) {
  if (!outer || !inner) return false
  return outer.start <= inner.start && outer.end >= inner.end
}
