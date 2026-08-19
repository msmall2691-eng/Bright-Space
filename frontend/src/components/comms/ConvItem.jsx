import { Link } from 'react-router-dom'
import { CHANNEL_CONFIG } from './constants'
import { contactDisplay, relTime } from './utils'
import { Avatar } from './primitives'
import { htmlToText } from '../../utils/format'

/** Left-list conversation row (Twenty CRM style): avatar + channel chip,
 *  name + relative time, preview, and Overdue/Unassigned chips when
 *  actionable. The unread pill floats right.
 *
 *  The row is a div[role=button] (not a <button>) so the client name can be a
 *  real <Link> to /clients/:id — nested interactive content inside a <button>
 *  is invalid HTML. Enter/Space still select via onKeyDown, matching the
 *  clickable-row pattern in ClientTableView. */
export function ConvItem({ conv, active, onClick }) {
  const name = contactDisplay(conv)
  const unread = conv.unread_count > 0
  const overdue = conv.sla_state === 'breached'
  const unassigned = !conv.assignee
  const channel = CHANNEL_CONFIG[conv.channel] || CHANNEL_CONFIG.sms
  const ChannelIcon = channel.icon
  const clientId = conv.client?.id ?? conv.client_id

  // Direction of the last real message, derived from timestamps the list
  // payload already carries — an outbound-last thread previews as "You: …"
  // so replied vs awaiting-reply threads read differently at a glance.
  const lastOut = conv.last_outbound_at ? Date.parse(conv.last_outbound_at) : 0
  const lastIn = conv.last_inbound_at ? Date.parse(conv.last_inbound_at) : 0
  const lastIsOutbound = lastOut > 0 && lastOut >= lastIn

  const nameCls = `text-[14px] truncate ${unread ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`

  return (
    <div role="button" tabIndex={0} onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e) } }}
      className={`group w-full text-left px-4 py-3 transition-colors border-b border-hairline cursor-pointer ${
        active ? 'bg-bg-2' : 'bg-panel hover:bg-bg-2/60'
      }`}>
      <div className="flex items-center gap-3">
        {/* Avatar with a neutral channel chip in the bottom-right corner. The
            chip is intentionally monochrome (icon carries the channel, not
            color) so a full list doesn't dot every row a different hue. */}
        <div className="relative shrink-0">
          <Avatar name={conv.client?.name || conv.external_contact} size="md" />
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-bg-2 ring-2 ring-panel flex items-center justify-center">
            <ChannelIcon className="w-2.5 h-2.5 text-ink-3" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + time. Linked client names go to the client record; the
              stopPropagation keeps the link from also selecting the row.
              The name sits in its own flex-1 wrapper so the ROW reserves the
              space for it (keeping the timestamp pinned right), but the
              <Link> itself is inline-block/max-w-full — its clickable box
              hugs the rendered (possibly truncated) text instead of
              stretching across the whole remaining row width. Previously the
              Link itself carried flex-1, so its tap target covered nearly
              the entire name/time row — tapping almost anywhere on a
              conversation row to open it landed on the client profile
              instead (owner report: "it always brings me to their client
              profile"). */}
          <div className="flex items-baseline gap-2">
            <div className="flex-1 min-w-0">
              {clientId ? (
                <Link to={`/clients/${clientId}`} onClick={e => e.stopPropagation()}
                  className={`${nameCls} inline-block max-w-full align-bottom hover:underline underline-offset-2`}>
                  {name}
                </Link>
              ) : (
                <span className={nameCls}>{name}</span>
              )}
            </div>
            <span className="text-[11px] text-ink-3 shrink-0 tabular-nums">
              {relTime(conv.last_message_at)}
            </span>
          </div>

          {/* Preview (single line) */}
          <p className={`text-[12.5px] truncate mt-0.5 ${unread ? 'text-ink-2' : 'text-ink-3'}`}>
            {lastIsOutbound && conv.preview && <span className="text-ink-3">You: </span>}
            {htmlToText(conv.preview) || 'No messages yet'}
          </p>

          {/* Status line — show at most ONE signal so the list doesn't become
              a wall of tags. "Overdue" (needs a reply) is the actionable one
              and wins; "Unassigned" is secondary and rendered as quiet muted
              text (it's also a filter), so an all-unassigned inbox doesn't
              light up amber on every row. */}
          {overdue ? (
            <div className="mt-1.5">
              <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Overdue
              </span>
            </div>
          ) : unassigned ? (
            <div className="mt-1 text-[10px] font-medium text-ink-3">Unassigned</div>
          ) : null}
        </div>

        {/* Unread — quiet dot + plain count, no filled bubble (owner veto). */}
        {unread && (
          <span className="flex items-center gap-1 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" aria-hidden="true" />
            <span className="text-[10px] font-bold tabular-nums text-ink">
              {conv.unread_count > 9 ? '9+' : conv.unread_count}
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
