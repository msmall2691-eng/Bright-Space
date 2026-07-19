import { Clock } from 'lucide-react'
import { CHANNEL_CONFIG } from './constants'
import { contactDisplay, relTime } from './utils'
import { Avatar } from './primitives'
import { htmlToText } from '../../utils/format'

/** Left-list conversation row (Twenty CRM style): avatar + channel chip,
 *  name + relative time, preview, and Overdue/Unassigned chips when
 *  actionable. The unread pill floats right. */
export function ConvItem({ conv, active, onClick }) {
  const name = contactDisplay(conv)
  const unread = conv.unread_count > 0
  const overdue = conv.sla_state === 'breached'
  const unassigned = !conv.assignee
  const channel = CHANNEL_CONFIG[conv.channel] || CHANNEL_CONFIG.sms
  const ChannelIcon = channel.icon

  return (
    <button onClick={onClick}
      className={`group w-full text-left px-4 py-3 transition-colors border-b border-hairline ${
        active
          ? 'bg-blue-50/60'
          : unread
            ? 'bg-panel hover:bg-bg'
            : 'bg-panel hover:bg-bg/70'
      }`}>
      <div className="flex items-center gap-3">
        {/* Avatar with channel chip in bottom-right corner */}
        <div className="relative shrink-0">
          <Avatar name={conv.client?.name || conv.external_contact} size="md" />
          <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${channel.bg} ring-2 ring-panel flex items-center justify-center`}>
            <ChannelIcon className={`w-2.5 h-2.5 ${channel.text}`} />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + time */}
          <div className="flex items-baseline gap-2">
            <span className={`text-[14px] truncate flex-1 ${unread ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>
              {name}
            </span>
            <span className="text-[11px] text-ink-3 shrink-0 tabular-nums">
              {relTime(conv.last_message_at)}
            </span>
          </div>

          {/* Preview (single line) */}
          <p className={`text-[12.5px] truncate mt-0.5 ${unread ? 'text-ink-2' : 'text-ink-3'}`}>
            {htmlToText(conv.preview) || 'No messages yet'}
          </p>

          {/* Status chips — only render when actionable */}
          {(overdue || unassigned) && (
            <div className="flex items-center gap-1.5 mt-1.5">
              {overdue && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-px rounded bg-red-50 text-red-700 border border-red-100">
                  <Clock className="w-2.5 h-2.5" /> Overdue
                </span>
              )}
              {unassigned && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-px rounded bg-amber-50 text-amber-700 border border-amber-100">
                  Unassigned
                </span>
              )}
            </div>
          )}
        </div>

        {/* Unread count pill */}
        {unread && (
          <span className="bg-indigo-600 text-white text-[10px] font-bold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center shrink-0 shadow-sm">
            {conv.unread_count > 9 ? '9+' : conv.unread_count}
          </span>
        )}
      </div>
    </button>
  )
}
