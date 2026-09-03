import { useNavigate } from 'react-router-dom'
import { MapPin, User } from 'lucide-react'
import StatusBadge from '../ui/StatusBadge'
import { PROPERTY_TYPE_CONFIG, VISIT_STATUS_CONFIG, computeDisplayStatus } from './constants'
import { TurnoverInfo, SyncStatusChips } from './SyncBadge'
import { mapsSearchUrl } from '../../utils/maps'

/** One schedule visit rendered as a full-width tappable card. Extracted from
 *  AgendaDay so the single-day agenda AND the multi-day "All upcoming" view
 *  render identical cards (tap → the same detail drawer via onSelect). Resolves
 *  its job/property/client from the shared maps, exactly as AgendaDay did.
 *
 *  `empName(id)` is optional — AgendaDay passes it so assigned cleaners show
 *  by name; AgendaUpcoming's payload has no employee roster, so the crew line
 *  falls back to the amber needs-cleaner cue only (never a bare id). */
export default function VisitCard({ v, jobs, properties, clients, onSelect, empName }) {
  const navigate = useNavigate()
  const job = jobs[v.job_id]
  const property = properties[job?.property_id]
  const client = clients[job?.client_id]
  const propertyType = property?.property_type || 'residential'
  const typeCfg = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  // Include the linked job so a missing property flips scheduled→needs_setup,
  // and a missing crew flips it to the quieter 'unassigned' (see constants.js).
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
  // Crew line. Same visit-first-then-job resolution as displayStatus above.
  // The Array.isArray guard matters: AgendaUpcoming's payload omits
  // cleaner_ids entirely, and "we don't know" must not render as "needs one".
  const cleanerIds = v.cleaner_ids?.length ? v.cleaner_ids : job?.cleaner_ids
  const needsCleaner = !isCancelled && v.status !== 'completed'
    && Array.isArray(cleanerIds) && cleanerIds.length === 0
  const crewNames = (Array.isArray(cleanerIds) && cleanerIds.length > 0 && empName)
    ? cleanerIds.map(id => empName(id)).filter(Boolean).slice(0, 2).join(', ')
      + (cleanerIds.length > 2 ? ` +${cleanerIds.length - 2}` : '')
    : null
  // Record links use spans, not <a>/<Link> — the whole card is already a
  // <button>, and HTML forbids nesting interactive elements. stopPropagation
  // keeps them from also opening the drawer.
  const goTo = (e, path) => { e.stopPropagation(); navigate(path) }
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
          {/* Quiet dot+word status — never a tinted capsule (owner veto). */}
          <StatusBadge status={statusCfg.badge} className="shrink-0">
            {statusCfg.label}
          </StatusBadge>
        </div>
        {/* Title row */}
        <div className="flex items-start gap-2 mb-1">
          {/* Flat type glyph — the colored edge bar already carries the type
              hue; a tinted icon chip on top of it was one bubble too many. */}
          <div className="shrink-0 mt-0.5 w-6 h-6 rounded-md border border-hairline bg-bg-2 flex items-center justify-center text-ink-3" title={typeCfg.label}>
            <TypeIcon className="w-3 h-3" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[14px] font-semibold text-ink ${isCancelled ? 'line-through' : ''}`}>
                {job?.title || `Visit ${v.id}`}
              </span>
              {v.ical_source && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-3 capitalize"
                  title={`Auto-scheduled from ${v.ical_source} iCal feed`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />
                  {v.ical_source === 'booking_com' ? 'Booking.com' : v.ical_source}
                </span>
              )}
            </div>
            {property?.address && (
              <div className="text-[12px] text-ink-3 mt-0.5 flex items-center gap-1">
                {job?.property_id ? (
                  <span
                    onClick={e => goTo(e, `/properties/${job.property_id}`)}
                    className="truncate hover:text-indigo-600 hover:underline cursor-pointer py-1 -my-1"
                    title="Open this property's record"
                    role="link"
                    tabIndex={-1}
                  >
                    {property.address}
                  </span>
                ) : (
                  <span className="truncate">{property.address}</span>
                )}
                {/* Plain span, not <a>/<button> — the whole card is already a
                    <button>, and HTML forbids nesting interactive elements.
                    Padded hit area (~32px) so a thumb can hit it on a phone. */}
                <span
                  onClick={e => { e.stopPropagation(); window.open(mapsSearchUrl(property.address), '_blank', 'noopener,noreferrer') }}
                  className="no-print shrink-0 text-ink-3 hover:text-indigo-600 cursor-pointer p-2 -my-2 -mr-1"
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
        {/* Meta footer — client link, crew (or needs-cleaner cue), sync chips. */}
        <div className="flex items-center gap-2 mt-2 text-[11px] text-ink-3 flex-wrap">
          {client?.name && (
            client?.id != null ? (
              <span
                onClick={e => goTo(e, `/clients/${client.id}`)}
                className="truncate hover:text-indigo-600 hover:underline cursor-pointer py-1 -my-1"
                title={`Open ${client.name}'s client record`}
                role="link"
                tabIndex={-1}
              >
                {client.name}
              </span>
            ) : (
              <span className="truncate">{client.name}</span>
            )
          )}
          {crewNames && (
            <span className="inline-flex items-center gap-1 truncate" title="Assigned cleaners">
              <User className="w-3 h-3 shrink-0" />
              <span className="truncate">{crewNames}</span>
            </span>
          )}
          {needsCleaner && (
            // Same calm amber-dot cue as the month chips — a word plus a dot,
            // never color alone.
            <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300 font-medium">
              <span className="w-[7px] h-[7px] rounded-full bg-amber-400 ring-2 ring-amber-200/70 dark:ring-amber-500/25" aria-hidden="true" />
              Needs a cleaner
            </span>
          )}
          {(v.open_for_claims || job?.open_for_claims) && !isCancelled && v.status !== 'completed' && (
            // Job is on the crew claim board — quiet dot+word state.
            <span className="inline-flex items-center gap-1.5 text-ink-3 font-medium" title="Crew can claim this job from their phone">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" aria-hidden="true" />
              Open to crew
            </span>
          )}
          <SyncStatusChips visit={v} job={job} />
        </div>
        {/* Airbnb/STR turnover context (guests, immediate flag, next check-in) */}
        <TurnoverInfo job={job} />
      </div>
    </button>
  )
}
