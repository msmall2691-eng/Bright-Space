import { useState } from 'react'
import { ClipboardList, ChevronDown } from 'lucide-react'
import { freqLabel } from './constants'

/** Compact, collapsible "Original request" card — the intake/quote-request the
 *  customer submitted, shown while writing or sending the quote so staff can
 *  see exactly what was asked for. Works the same on phone and desktop.
 *
 *  `intake` is the summary shape from the backend (_intake_summary) OR the raw
 *  LeadIntake the Quoting page already holds in `selectedIntake` — both carry
 *  the same field names. `defaultOpen` expands it on first render (handy on the
 *  detail page where there's room); the editor passes false to stay tidy. */
export default function OriginalRequestCard({ intake, defaultOpen = false, className = '' }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!intake) return null

  const svc = (intake.service_type || '').replace('_', ' ')
  const size = [
    intake.square_footage && `${Number(intake.square_footage).toLocaleString()} sqft`,
    intake.bedrooms != null && `${intake.bedrooms} bd`,
    intake.bathrooms != null && `${intake.bathrooms} ba`,
    intake.guests != null && `${intake.guests} guests`,
  ].filter(Boolean).join(' · ')
  const when = intake.requested_date || intake.preferred_date
  const window = intake.check_in && intake.check_out
    ? `${intake.check_in} → ${intake.check_out}`
    : [when, intake.preferred_time].filter(Boolean).join(' · ')

  // Field rows shown when expanded — only the ones that have a value.
  const rows = [
    ['Service', [freqLabel(intake.frequency), svc].filter(Boolean).join(' ') || svc],
    ['Property', size],
    ['Requested', window],
    ['Address', intake.address || intake.location],
    ['Contact', [intake.phone, intake.email].filter(Boolean).join(' · ')],
    (intake.estimate_min != null || intake.estimate_max != null) && ['Website estimate',
      intake.estimate_min != null && intake.estimate_max != null
        ? `$${intake.estimate_min}–$${intake.estimate_max}`
        : `$${intake.estimate_max ?? intake.estimate_min}`],
    ['Source', intake.source],
  ].filter(Boolean).filter(([, v]) => v)

  return (
    <div className={`rounded-lg border border-hairline bg-bg-2 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
      >
        <ClipboardList className="w-4 h-4 text-ink-3 shrink-0" />
        <span className="text-sm font-semibold text-ink">Original request</span>
        {intake.name && <span className="text-xs text-ink-3 truncate">from {intake.name}</span>}
        <ChevronDown className={`w-4 h-4 text-ink-3 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {intake.message && (
            <div className="rounded-md bg-panel border border-hairline px-3 py-2 text-[13px] text-ink-2 whitespace-pre-wrap">
              “{intake.message}”
            </div>
          )}
          {rows.length > 0 && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[12px]">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-ink-3">{label}</dt>
                  <dd className="text-ink-2 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
