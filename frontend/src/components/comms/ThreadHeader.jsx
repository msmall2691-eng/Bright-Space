import { ArrowLeft, Clock, CheckCircle2, User } from 'lucide-react'
import { formatPhone } from '../../utils/display'
import { CHANNEL_CONFIG } from './constants'
import { contactDisplay, relTime } from './utils'
import { Avatar, SlaBadge } from './primitives'
import { AssigneePicker } from './AssigneePicker'

/** Top of the center pane when a conversation is open:
 *   • Optional red Overdue banner (SLA breached).
 *   • Avatar + channel chip, contact display name, phone/email row.
 *   • Mark done / re-open toggle, contact-panel toggle (desktop),
 *     back button (mobile). */
export function ThreadHeader({
  detail,
  showContactPanel, setShowContactPanel,
  setMobileView,
  onToggleStatus,
  onAssign,
}) {
  const ch = CHANNEL_CONFIG[detail.channel] || CHANNEL_CONFIG.sms
  const ChannelIcon = ch.icon

  return (
    <>
      {/* Phase 8: Overdue banner (renamed from "SLA breached"). */}
      {detail.sla_state === 'breached' && (
        <div className="bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/25 px-5 py-2.5 flex items-center gap-2 text-[12px] font-medium text-red-700 dark:text-red-300">
          <Clock className="w-4 h-4" />
          Overdue — last reply {relTime(detail.last_inbound_at)} ago
        </div>
      )}

      {/* Thread header */}
      <div className="border-b border-hairline px-5 py-3.5 flex items-center gap-3 bg-panel">
        {/* Mobile back button */}
        <button onClick={() => setMobileView('list')}
          className="w-9 h-9 -ml-1 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3 lg:hidden">
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Avatar with channel chip in corner — matches the inbox row */}
        <div className="relative shrink-0">
          <Avatar name={detail.client?.name || detail.external_contact} size="md" />
          <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${ch.bg} ring-2 ring-panel flex items-center justify-center`}>
            <ChannelIcon className={`w-2.5 h-2.5 ${ch.text}`} />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-ink text-[15px] truncate">{contactDisplay(detail)}</h2>
            <SlaBadge state={detail.sla_state} />
          </div>
          <div className="text-[12px] text-ink-3 mt-0.5 truncate">
            {detail.client?.phone && formatPhone(detail.client.phone)}
            {detail.client?.phone && detail.client?.email && <span className="mx-1.5 text-ink-3">·</span>}
            {detail.client?.email && detail.client.email}
            {!detail.client?.phone && !detail.client?.email && detail.external_contact && formatPhone(detail.external_contact)}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          {onAssign && (
            <AssigneePicker
              currentName={detail.assignee}
              currentId={detail.assignee_user_id}
              onAssign={onAssign}
            />
          )}
          <button onClick={onToggleStatus}
            className={`text-[12px] font-semibold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 ${
              detail.status === 'resolved'
                ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/25 ring-1 ring-emerald-200 dark:ring-emerald-500/30'
                : 'bg-bg-2 text-ink-2 hover:bg-emerald-50 dark:hover:bg-emerald-500/15 hover:text-emerald-700 dark:hover:text-emerald-300'
            }`}>
            <CheckCircle2 className="w-3.5 h-3.5" />
            {detail.status === 'resolved' ? 'Done' : 'Mark done'}
          </button>
          {/* Contact/details: on mobile this switches to the contact pane
              (mobileView='contact'); on desktop it toggles the side panel. */}
          <button onClick={() => { setShowContactPanel(v => !v); setMobileView('contact') }}
            className="w-9 h-9 rounded-lg bg-bg-2 hover:bg-hairline flex items-center justify-center text-ink-3 transition-colors">
            <User className="w-4 h-4" />
          </button>
        </div>
      </div>
    </>
  )
}
