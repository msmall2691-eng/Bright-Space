import { X, Zap, ChevronDown, CheckCircle, AlertCircle, Clock, Edit2, Trash2 } from 'lucide-react'
import Button from '../ui/Button'
import GlassCard from '../ui/GlassCard'
import StatusBadge from '../ui/StatusBadge'
import { VISIT_STATUS_CONFIG, shortDate, cleanerInitials } from './constants'

/** Right-side (bottom-sheet on mobile) drawer for a single visit. Pure
 *  props-in: the parent owns the selection + all mutation callbacks so
 *  this component can stay closure-free.
 *
 *  Props:
 *    selectedVisit — { visit, job, property } bundle to render.
 *    showMore, onToggleMore — collapse state for the sync/reminder block.
 *    jobEvents — recent GCal audit rows for the drawer's status pill.
 *    empName(id) — resolves cleaner id → display name.
 *    onClose, onNavigateJob(jobId), onComplete(visit), onEditJob(job),
 *    onDelete(visitId), onToggleReminder(job, nextSkipValue) — parent-owned
 *    handlers wired to Schedule's existing state + API calls. */
export default function VisitDetailsDrawer({
  selectedVisit,
  showMore,
  onToggleMore,
  jobEvents,
  empName,
  onClose,
  onNavigateJob,
  onComplete,
  onEditJob,
  onDelete,
  onToggleReminder,
}) {
  if (!selectedVisit) return null
  const { visit, job, property } = selectedVisit
  const canComplete = visit.status !== 'completed' && visit.status !== 'cancelled'
  return (
    // Tap the dimmed backdrop to close — standard bottom-sheet behavior on
    // mobile. stopPropagation on the sheet itself keeps in-sheet clicks safe.
    <div
      className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-end"
      onClick={onClose}
    >
      <GlassCard
        className="w-full sm:w-96 h-[95vh] sm:max-h-[90vh] sm:h-auto rounded-t-2xl sm:rounded-lg m-0 sm:m-4 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — visual affordance that this sheet dismisses from
            the top. Mobile only; the desktop drawer looks silly with one. */}
        <div className="sm:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-ink-3/30" aria-hidden="true" />
        </div>
        <div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto">
          <div className="flex items-center justify-between mb-4 sm:mb-6">
            <h2 className="text-lg sm:text-xl font-bold text-ink">Visit Details</h2>
            <div className="flex items-center gap-1">
              {job?.id && (
                <button
                  onClick={() => onNavigateJob(job.id)}
                  className="text-[12px] font-medium text-blue-500 hover:underline px-2 py-1"
                >
                  Open full page
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 sm:p-1 hover:bg-bg-2 rounded active:bg-bg-2 -mr-2 sm:mr-0"
              >
                <X className="w-5 sm:w-5 h-5 sm:h-5" />
              </button>
            </div>
          </div>

          <div className="space-y-3 sm:space-y-4">
            <div>
              <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Date & Time</p>
              <p className="text-sm sm:text-base text-ink">
                {visit.scheduled_date && String(visit.scheduled_date).trim()
                  ? `${new Date(`${visit.scheduled_date}T${visit.start_time || '09:00'}`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} @ ${(visit.start_time || '09:00').slice(0, 5)}`
                  : 'Unscheduled — pick a date in Edit Job'
                }
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Property</p>
              <p className="text-sm sm:text-base text-ink">{property?.name}</p>
            </div>

            <div>
              <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Address</p>
              <p className="text-sm sm:text-base text-ink break-words">{property?.address}</p>
            </div>

            {/* On-site access details (house code, entry/parking notes, site
                contact, STR check-in/out) — what a crew needs to get in. */}
            {(() => {
              const p = property || {}
              if (!(p.house_code || p.access_notes || p.parking_notes || p.site_contact_name || p.site_contact_phone || p.check_in_time || p.check_out_time)) return null
              return (
                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Access</p>
                  <div className="text-sm text-ink space-y-0.5">
                    {p.house_code && <p>Code <span className="font-semibold">{p.house_code}</span></p>}
                    {p.access_notes && <p className="break-words">{p.access_notes}</p>}
                    {p.parking_notes && <p className="text-ink-2">Parking: {p.parking_notes}</p>}
                    {(p.site_contact_name || p.site_contact_phone) && (
                      <p>Site contact: {p.site_contact_name || ''}{p.site_contact_phone ? ` · ${p.site_contact_phone}` : ''}</p>
                    )}
                    {(p.check_out_time || p.check_in_time) && (
                      <p className="text-ink-3">
                        {p.check_out_time ? `Checkout ${p.check_out_time}` : ''}
                        {p.check_out_time && p.check_in_time ? ' · ' : ''}
                        {p.check_in_time ? `Check-in ${p.check_in_time}` : ''}
                      </p>
                    )}
                  </div>
                </div>
              )
            })()}

            <div>
              <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Client</p>
              <p className="text-sm sm:text-base text-ink">{job?.client_name}</p>
            </div>

            <div>
              <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Status</p>
              <StatusBadge status={VISIT_STATUS_CONFIG[visit.status]?.badge || 'info'}>
                {VISIT_STATUS_CONFIG[visit.status]?.label || visit.status}
              </StatusBadge>
            </div>

            {/* Airbnb/STR turnover details */}
            {job?.job_type === 'str_turnover' &&
              (job?.booking || job?.next_arrival || job?.is_immediate_turnover) && (
              <div>
                <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Turnover</p>
                {job?.is_immediate_turnover && (
                  <p className="inline-flex items-center gap-1 text-sm font-semibold text-red-700 mb-1">
                    <Zap className="w-3.5 h-3.5" /> Same-day turnaround — next guest arrives today
                  </p>
                )}
                <div className="text-sm text-ink space-y-0.5">
                  {job?.booking?.source && (
                    <p>Source: <span className="capitalize">{job.booking.source}</span></p>
                  )}
                  {job?.booking?.guest_count > 0 && (
                    <p>{job.booking.guest_count} guest(s) checked out</p>
                  )}
                  {job?.booking?.checkout_date && (
                    <p>Checkout: {shortDate(job.booking.checkout_date)}</p>
                  )}
                  {job?.next_arrival?.checkin_date && (
                    <p>Next check-in: {shortDate(job.next_arrival.checkin_date)}</p>
                  )}
                </div>
              </div>
            )}

            {visit.cleaner_ids?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Assigned Cleaners</p>
                <div className="flex flex-wrap gap-1.5">
                  {visit.cleaner_ids.map((cid, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 text-sm text-ink bg-bg-2 pl-1 pr-2.5 py-0.5 rounded-full">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[9px] font-bold">
                        {cleanerInitials(empName(cid) || `C${cid}`)}
                      </span>
                      {empName(cid) || `Cleaner ${cid}`}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Secondary details (calendar sync, SMS reminder) folded away. */}
            <button type="button" onClick={onToggleMore}
              className="flex items-center gap-1.5 text-xs font-semibold text-ink-2 hover:text-ink border-t border-hairline pt-3 w-full">
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} />
              More details
            </button>

            {showMore && (jobEvents.length > 0 || visit.gcal_event_id) && (
              <div>
                <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Google Calendar</p>
                {(() => {
                  const latest = jobEvents[0]
                  if (!latest) {
                    return <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700"><CheckCircle className="w-3.5 h-3.5" /> Synced</span>
                  }
                  const when = latest.created_at ? new Date(latest.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
                  if (latest.status === 'failed') {
                    return (
                      <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700" title={latest.error_message || ''}>
                        <AlertCircle className="w-3.5 h-3.5" /> {latest.action === 'delete' ? 'Calendar removal failed' : 'Calendar sync failed'}{when && ` · ${when}`}
                      </span>
                    )
                  }
                  if (latest.action === 'delete') {
                    return (
                      <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-bg-2 text-ink-2">
                        <Clock className="w-3.5 h-3.5" /> Removed from calendar{when && ` · ${when}`}
                      </span>
                    )
                  }
                  return (
                    <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                      <CheckCircle className="w-3.5 h-3.5" /> Synced{when && ` · ${when}`}
                    </span>
                  )
                })()}
                {jobEvents[0]?.status === 'failed' && jobEvents[0]?.error_message && (
                  <p className="text-[11px] text-red-600 mt-1 break-words">{String(jobEvents[0].error_message).slice(0, 200)}</p>
                )}
              </div>
            )}

            {/* SMS reminder toggle — reminders are on by default; staff can
                suppress the 24h text for this booking only. */}
            {showMore && visit.status !== 'completed' && visit.status !== 'cancelled' && (
              <div className="border-t border-hairline pt-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-0.5">SMS reminder</p>
                  <p className="text-[12px] text-ink-3">
                    {job?.skip_sms_reminder
                      ? '🔕 Off — no 24h text for this booking'
                      : '🔔 On — client gets a 24h reminder'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleReminder(job, !job?.skip_sms_reminder)}
                  className={`text-[12px] font-semibold px-3 py-1.5 rounded-lg border whitespace-nowrap transition-colors ${
                    job?.skip_sms_reminder
                      ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                      : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                  }`}
                >
                  {job?.skip_sms_reminder ? 'Enable' : 'Disable'}
                </button>
              </div>
            )}

            {/* Completion summary, once a visit has been completed */}
            {visit.status === 'completed' && (
              <div className="border-t border-hairline pt-3">
                <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Completion</p>
                {(visit.completed_at || visit.completed_by) && (
                  <p className="text-[12px] text-ink-3 mb-1">
                    {visit.completed_at && `Completed ${new Date(visit.completed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                    {visit.completed_by && ` · by ${empName(visit.completed_by)}`}
                  </p>
                )}
                {visit.checklist_results && (
                  <ul className="text-sm text-ink space-y-0.5">
                    {Object.entries(visit.checklist_results).map(([task, done]) => (
                      <li key={task} className="flex items-center gap-1.5">
                        <span className={done ? 'text-green-600' : 'text-ink-3'}>{done ? '✓' : '○'}</span>
                        {task}
                      </li>
                    ))}
                  </ul>
                )}
                {visit.photos?.length > 0 && (
                  <p className="text-sm text-ink mt-1">{visit.photos.length} photo(s) attached</p>
                )}
              </div>
            )}

          </div>
        </div>

        {/* Sticky action footer — stays thumb-reachable on mobile even when
            the visit has enough content to fill the sheet. Sits below the
            scrolling area (flex-col above), with a hairline separator. */}
        <div
          className="border-t border-hairline px-4 py-3 sm:px-6 sm:py-4 bg-panel flex flex-col-reverse sm:flex-row gap-2"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
        >
          {canComplete && (
            <Button
              variant="primary"
              size="sm"
              className="w-full sm:flex-1"
              onClick={() => onComplete(visit)}
            >
              <CheckCircle className="w-4 h-4 mr-2" />
              Complete
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="w-full sm:flex-1"
            onClick={() => onEditJob(job)}
          >
            <Edit2 className="w-4 h-4 mr-2" />
            Edit Job
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="w-full sm:flex-1"
            onClick={() => onDelete(visit.id)}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
        </div>
      </GlassCard>
    </div>
  )
}
