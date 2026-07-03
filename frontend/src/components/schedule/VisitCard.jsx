import { CheckCircle, Zap, MessageCircle, Camera, Edit2, Trash2 } from 'lucide-react'
import RecordLink from '../RecordLink'
import StatusBadge from '../ui/StatusBadge'
import { PROPERTY_TYPE_CONFIG, VISIT_STATUS_CONFIG, VISIT_ACCENT } from './constants'
import { SyncBadge } from './SyncBadge'

export default function VisitCard({
  visit, job, property, client,
  onEdit, onDelete, onStatusChange,
  selected, onToggleSelect,
  empName,
}) {
  const propertyType = property?.property_type || 'residential'
  const config = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  const PropertyIcon = config.icon
  const statusConfig = VISIT_STATUS_CONFIG[visit.status] || VISIT_STATUS_CONFIG.scheduled
  const accent = VISIT_ACCENT[propertyType] || 'border-l-blue-400'

  const cleaners = visit.cleaner_ids || []
  const hasAssigned = cleaners.length > 0
  const hasGcal = !!(visit.gcal_event_id || job?.gcal_event_id)
  const hasConnecteam = (job?.connecteam_shift_ids || []).length > 0
  const hasSMS = !!job?.sms_reminder_sent
  const hasPhotos = (visit.photos || []).length > 0
  const isCompleted = visit.status === 'completed'

  // Phase 8 redesign: tighter list-row layout. Single horizontal row with
  // time on the left, title + property + status inline, action overflow on
  // the right. ~30% less vertical space, easier to scan.
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2 sm:px-4 sm:py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected ? 'bg-blue-50 ring-1 ring-blue-300' : 'bg-panel hover:bg-bg'
      } border border-hairline border-l-4 ${accent}`}
      onClick={() => onEdit(visit, job, property)}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onToggleSelect?.(visit.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="w-3.5 h-3.5 rounded border-hairline cursor-pointer shrink-0"
        data-testid="visit-row-checkbox"
        aria-label="Select visit"
      />

      {/* Start time — fixed width column */}
      <div className="text-[12px] font-semibold text-ink tabular-nums w-12 shrink-0">
        {visit.start_time?.slice(0, 5) || '—'}
      </div>

      {/* Property type icon */}
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${config.badge}`}>
        <PropertyIcon className="w-3.5 h-3.5" />
      </div>

      {/* Title + property + client on one stacked line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-ink truncate">
            {job?.title || `Visit ${visit.id}`}
          </span>
          {isCompleted && <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />}
          {job?.is_immediate_turnover && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded bg-red-100 text-red-700 shrink-0"
              title="Same-day turnaround — next guest checks in today">
              <Zap className="w-2.5 h-2.5" /> Immediate
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-3 truncate flex items-center gap-1">
          {property && (
            <span onClick={e => e.stopPropagation()}>
              <RecordLink type="property" id={property.id} label={property.name || property.address} className="!text-ink-3 hover:!text-blue-500" />
            </span>
          )}
          {client && (
            <>
              <span className="text-ink-3">·</span>
              <span onClick={e => e.stopPropagation()}>
                <RecordLink type="client" id={client.id} label={client.name} className="!text-ink-3 hover:!text-blue-500" />
              </span>
            </>
          )}
        </div>
      </div>

      {/* Status icons + pill + sync badges */}
      <div className="hidden sm:flex items-center gap-1.5 shrink-0">
        <div className="flex items-center gap-1">
          {hasSMS && <span title="Reminder sent"><MessageCircle className="w-3.5 h-3.5 text-cyan-500" /></span>}
          {hasPhotos && <span title="Photos attached"><Camera className="w-3.5 h-3.5 text-emerald-500" /></span>}
        </div>
        <StatusBadge status={statusConfig.badge} className="text-[10px]">{statusConfig.label}</StatusBadge>
        <SyncBadge ok={hasGcal} label="GCal" okTitle="On Google Calendar" offTitle="Not on Google Calendar yet" />
        <SyncBadge ok={hasConnecteam} label="Connecteam" okTitle="Shift in Connecteam" offTitle="Not sent to Connecteam yet" />
      </div>

      {/* Mobile-only status pill — replaces the bare dot so the status
          is actually legible at a glance. */}
      <span className={`sm:hidden inline-flex items-center text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${statusConfig.pillMobile || 'bg-bg-2 text-ink-2'}`}>
        {statusConfig.label}
      </span>

      {/* Action buttons — desktop only. Mobile relies on tap-row → detail
          panel, which has its own edit + delete buttons; doubling them up
          here was eating title space and made delete easy to mis-tap. */}
      <div className="hidden sm:flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(visit, job, property) }}
          className="p-1.5 rounded hover:bg-blue-100 text-ink-3 hover:text-blue-600"
          title="Edit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(visit.id) }}
          className="p-1.5 rounded hover:bg-red-100 text-ink-3 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
