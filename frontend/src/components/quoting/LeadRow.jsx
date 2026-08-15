import { Plus, Phone, Mail, MapPin, Calendar, Clock } from 'lucide-react'
import InlineSelect from '../InlineSelect'
import { formatDate } from '../../utils/format'
import { LEAD_STATUS_OPTIONS } from './constants'

/** A single row in the Leads tab (rendered from the /api/intake list).
 *  Pure props-in — parent owns the mutation callbacks. */
export default function LeadRow({
  intake,
  canEdit,
  onUpdateStatus,
  onMarkReviewed,
  onCreateQuote,
  onOpenClient,
}) {
  return (
    <div className="p-3 hover:bg-bg-2/40 transition-colors">
      <div className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4">
        <div className="flex-1 min-w-0 w-full">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="font-medium text-ink">{intake.name}</span>
            <span onClick={e => e.stopPropagation()}>
              <InlineSelect value={intake.status} options={LEAD_STATUS_OPTIONS}
                onSelect={(s) => onUpdateStatus(intake.id, s)}
                disabled={!canEdit || intake.status === 'converted'} />
            </span>
            <span className="text-xs text-ink-3 capitalize bg-bg-2 px-2 py-0.5 rounded-full">{intake.service_type}</span>
          </div>
          {/* Structured request chips — the data the customer entered on
              the website (sqft/beds/baths/frequency/estimate), so the
              operator reads it at a glance instead of from the message blob. */}
          {(intake.square_footage || intake.bedrooms || intake.bathrooms || intake.frequency
            || intake.estimate_min != null || intake.estimate_max != null) && (
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              {intake.square_footage ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.square_footage.toLocaleString()} sqft</span> : null}
              {intake.bedrooms ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.bedrooms} bd</span> : null}
              {intake.bathrooms ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.bathrooms} ba</span> : null}
              {intake.frequency ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2 capitalize">{intake.frequency}</span> : null}
              {(intake.estimate_min != null && intake.estimate_max != null) ? (
                <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 font-medium text-emerald-700 dark:text-emerald-300 tabular-nums">
                  ${Math.round(intake.estimate_min)}–${Math.round(intake.estimate_max)}
                </span>
              ) : (intake.estimate_min != null || intake.estimate_max != null) ? (
                // One bound only (partial/legacy data) — show that bound
                // approximately rather than the broken "$?–$220" shape.
                <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 font-medium text-emerald-700 dark:text-emerald-300 tabular-nums">
                  ~${Math.round(intake.estimate_max ?? intake.estimate_min)}
                </span>
              ) : null}
            </div>
          )}
          <div className="text-xs text-ink-3 space-y-1">
            {(intake.phone || intake.email) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {intake.phone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5 shrink-0" />{intake.phone}</span>}
                {intake.email && <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5 shrink-0" />{intake.email}</span>}
              </div>
            )}
            {intake.address && (
              <div className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 shrink-0" />
                {[intake.address, intake.city, intake.state].filter(Boolean).join(', ')}
              </div>
            )}
            {intake.preferred_date && (
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 shrink-0" />Preferred: {formatDate(intake.preferred_date)}
              </div>
            )}
            {intake.message && <div className="text-ink-3 italic mt-1 line-clamp-2">"{intake.message}"</div>}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            {new Date(intake.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
        {/* Actions: a wrapping row under the content on mobile, a right-hand
            column on desktop. */}
        <div className="flex flex-wrap sm:flex-col gap-1.5 shrink-0 w-full sm:w-auto">
          {canEdit && intake.status === 'new' && (
            <button onClick={() => onMarkReviewed(intake.id)}
              className="text-xs px-3 py-2 sm:py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 rounded-lg transition-colors border border-hairline">
              Mark Reviewed
            </button>
          )}
          {canEdit && intake.status !== 'converted' && (
            <button onClick={() => onCreateQuote(intake)}
              className="text-xs px-3 py-2 sm:py-1.5 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 rounded-lg transition-colors flex items-center gap-1 font-medium">
              <Plus className="w-3 h-3" /> Create Quote
            </button>
          )}
          {intake.client_id && (
            <button onClick={() => onOpenClient(intake.client_id)}
              className="text-xs px-3 py-2 sm:py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-3 rounded-lg transition-colors">
              View Client
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
