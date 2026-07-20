import { MapPin } from 'lucide-react'
import { PROPERTY_TYPE_CONFIG, VISIT_STATUS_CONFIG, computeDisplayStatus } from './constants'
import { TurnoverInfo, SyncStatusChips } from './SyncBadge'
import { mapsSearchUrl } from '../../utils/maps'

/** One schedule visit rendered as a full-width tappable card. Extracted from
 *  AgendaDay so the single-day agenda AND the multi-day "All upcoming" view
 *  render identical cards (tap → the same detail drawer via onSelect). Resolves
 *  its job/property/client from the shared maps, exactly as AgendaDay did. */
export default function VisitCard({ v, jobs, properties, clients, onSelect }) {
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
  const isCancelled = v.status === 'cancelled'
  return (
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
              <div className="text-[12px] text-ink-3 mt-0.5 flex items-center gap-1">
                <span className="truncate">{property.address}</span>
                {/* Plain span, not <a>/<button> — the whole card is already a
                    <button>, and HTML forbids nesting interactive elements. */}
                <span
                  onClick={e => { e.stopPropagation(); window.open(mapsSearchUrl(property.address), '_blank', 'noopener,noreferrer') }}
                  className="no-print shrink-0 text-ink-3 hover:text-indigo-600 cursor-pointer"
                  title="Open in Google Maps"
                  role="button"
                  tabIndex={-1}
                >
                  <MapPin className="w-3 h-3" />
                </span>
              </div>
            )}
          </div>
        </div>
        {/* Meta footer — client name + at-a-glance sync chips. */}
        <div className="flex items-center gap-2 mt-2 text-[11px] text-ink-3 flex-wrap">
          {client?.name && <span className="truncate">{client.name}</span>}
          <SyncStatusChips visit={v} job={job} />
        </div>
        {/* Airbnb/STR turnover context (guests, immediate flag, next check-in) */}
        <TurnoverInfo job={job} />
      </div>
    </button>
  )
}
