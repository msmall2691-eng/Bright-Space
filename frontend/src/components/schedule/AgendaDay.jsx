import { Link } from 'react-router-dom'
import { Calendar, CornerUpLeft } from 'lucide-react'
import { toLocalYMD } from '../../utils/format'
import DayActionButtons from './DayActionButtons'
import VisitCard from './VisitCard'

/** Single-day mobile-first view. Renders the day's visits as full-width
 *  cards. Tap a card to open the existing detail drawer via onSelect (same
 *  handler the list view's cards use, so detail-panel behavior is identical).
 *
 *  Mobile niceties:
 *   - Sticky day header so the date/count context is visible while scrolling
 *     a long day (matters when a cleaner is looking at 8+ visits in the field).
 *   - Floating "Today" pill in the bottom-right when currentDate ≠ today, so
 *     one thumb tap returns to the day the operator lives in most.
 */
export default function AgendaDay({
  currentDate, visits, jobs, properties, clients, onSelect, isToday, empName,
  onJumpToToday,
  // Hide AgendaDay's own sticky day header when a parent (AgendaHero) is
  // already carrying the "Tuesday · Jul 8" hierarchy. Default keeps the
  // original behavior so other callers of AgendaDay aren't affected.
  hideHeader = false,
}) {
  // Sort by start_time so the day reads top-down chronologically. Visits
  // without a start_time sink to the bottom.
  const sorted = [...(visits || [])].sort((a, b) => {
    const at = (a.start_time || '99:99').slice(0, 5)
    const bt = (b.start_time || '99:99').slice(0, 5)
    return at.localeCompare(bt)
  })
  const completed = sorted.filter(v => v.status === 'completed').length
  return (
    <div className="flex-1 overflow-auto relative">
      {/* Extra bottom padding on mobile so the last visit card isn't hidden
          behind the floating "Ask AI" pill (bottom-[4.75rem]) or the bottom
          nav. Audit §13: the pill was overlapping content on small viewports.
          Desktop keeps the standard pb-6. */}
      <div className="max-w-2xl mx-auto px-3 pb-24 sm:pb-6">
        {/* Day header — sticky so the date + count stay visible during scroll.
            top-0 sits it below the parent toolbar (also sticky) inside this
            scroll container. bg matches the panel so it fully covers cards.
            Hidden when the parent AgendaHero is already rendering the
            weekday hierarchy above. */}
        {!hideHeader && (
          <div className="sticky top-0 z-[5] -mx-3 px-3 pt-3 pb-2 mb-2 bg-bg border-b border-hairline/50 flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                {isToday ? 'Today' : ''}
              </div>
              <h2 className="text-xl font-bold text-ink tracking-tight">
                {new Date(`${toLocalYMD(currentDate)}T00:00`).toLocaleDateString('en-US', {
                  weekday: 'long', month: 'long', day: 'numeric',
                })}
              </h2>
              {sorted.length > 0 && (
                <p className="text-[12px] text-ink-3 mt-0.5">
                  {sorted.length} job{sorted.length === 1 ? '' : 's'}
                  {completed > 0 && ` · ${completed} done`}
                </p>
              )}
            </div>
            <DayActionButtons visits={sorted} jobs={jobs} properties={properties} className="mt-1" />
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="bg-panel border border-hairline rounded-2xl p-10 text-center">
            <Calendar className="w-8 h-8 text-ink-3 mx-auto mb-2" />
            <p className="text-[13px] text-ink-3">Nothing scheduled for this day</p>
            <p className="text-[12px] text-ink-3 mt-2">
              Create one, or <Link to="/properties" className="underline hover:text-ink-2">import a property's iCal feed</Link>
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map((v) => (
              <li key={v.id}>
                <VisitCard v={v} jobs={jobs} properties={properties} clients={clients} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Floating "Today" jump pill — only when we're viewing another day and
          the parent gave us a handler. Bottom-right, above the iOS home
          indicator (safe-area bottom padding). One-thumb reach on phones. */}
      {!isToday && typeof onJumpToToday === 'function' && (
        <button
          onClick={onJumpToToday}
          style={{ bottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
          className="fixed right-4 z-20 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-ink text-panel shadow-lg active:scale-95 transition-transform text-[13px] font-semibold"
          data-testid="jump-to-today"
          aria-label="Jump to today"
        >
          <CornerUpLeft className="w-3.5 h-3.5" />
          Today
        </button>
      )}
    </div>
  )
}
