import { Calendar, CornerUpLeft } from 'lucide-react'
import { PROPERTY_TYPE_CONFIG, VISIT_STATUS_CONFIG, computeDisplayStatus } from './constants'
import { TurnoverInfo } from './SyncBadge'
import { toLocalYMD } from '../../utils/format'

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
            scroll container. bg matches the panel so it fully covers cards. */}
        <div className="sticky top-0 z-[5] -mx-3 px-3 pt-3 pb-2 mb-2 bg-bg border-b border-hairline/50">
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

        {sorted.length === 0 ? (
          <div className="bg-panel border border-hairline rounded-2xl p-10 text-center">
            <Calendar className="w-8 h-8 text-ink-3 mx-auto mb-2" />
            <p className="text-[13px] text-ink-3">Nothing scheduled for this day</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map((v) => {
              const job = jobs[v.job_id]
              const property = properties[job?.property_id]
              const client = clients[job?.client_id]
              const propertyType = property?.property_type || 'residential'
              const typeCfg = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
              // Include the linked job so property/crew absence flips scheduled→needs_setup.
              const displayStatus = computeDisplayStatus({
                ...v,
                property_id: job?.property_id,
                cleaner_ids: v.cleaner_ids?.length ? v.cleaner_ids : job?.cleaner_ids,
              })
              const statusCfg = VISIT_STATUS_CONFIG[displayStatus] || VISIT_STATUS_CONFIG.scheduled
              const TypeIcon = typeCfg.icon
              const startHHMM = (v.start_time || '').slice(0, 5)
              const endHHMM = (v.end_time || '').slice(0, 5)
              const cleanerCount = v.cleaner_ids?.length || 0
              const isCancelled = v.status === 'cancelled'
              return (
                <li key={v.id}>
                  <button
                    onClick={() => onSelect(v, job, property)}
                    className={`group w-full text-left flex items-stretch rounded-2xl border bg-panel overflow-hidden transition-all active:scale-[0.99] ${
                      isCancelled
                        ? 'border-hairline opacity-60'
                        : 'border-hairline hover:border-hairline hover:shadow-sm'
                    }`}
                  >
                    {/* Color bar — job type signal */}
                    <span className={`w-1.5 shrink-0 ${
                      propertyType === 'str' ? 'bg-amber-400'
                      : propertyType === 'commercial' ? 'bg-purple-400'
                      : 'bg-blue-400'
                    }`} />
                    <div className="flex-1 min-w-0 p-3">
                      {/* Time row */}
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[14px] font-bold text-ink tabular-nums">
                          {startHHMM || '—'}
                          {endHHMM && <span className="text-ink-3 font-medium"> – {endHHMM}</span>}
                        </span>
                        <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${statusCfg.pillMobile}`}>
                          {statusCfg.label}
                        </span>
                      </div>
                      {/* Title row */}
                      <div className="flex items-start gap-2 mb-1">
                        <div className={`shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center ${typeCfg.badge}`}>
                          <TypeIcon className="w-3 h-3" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[14px] font-semibold text-ink ${isCancelled ? 'line-through' : ''}`}>
                              {job?.title || `Visit ${v.id}`}
                            </span>
                            {v.ical_source && (
                              <span
                                className="inline-flex items-center text-[10px] font-semibold px-1.5 py-px rounded bg-amber-50 text-amber-700 capitalize"
                                title={`Auto-scheduled from ${v.ical_source} iCal feed`}
                              >
                                {v.ical_source === 'booking_com' ? 'Booking.com' : v.ical_source}
                              </span>
                            )}
                          </div>
                          {property?.address && (
                            <div className="text-[12px] text-ink-3 mt-0.5">
                              {property.address}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Meta footer — just the client. Calendar/Connecteam sync
                          state lives in the visit drawer's "More details" now,
                          so it doesn't clutter every card. */}
                      {client?.name && (
                        <div className="flex items-center gap-2 mt-2 text-[11px] text-ink-3">
                          <span className="truncate">{client.name}</span>
                        </div>
                      )}
                      {/* Airbnb/STR turnover context (guests, immediate flag, next check-in) */}
                      <TurnoverInfo job={job} />
                    </div>
                  </button>
                </li>
              )
            })}
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
