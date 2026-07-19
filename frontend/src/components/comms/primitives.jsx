import { useState } from 'react'
import { Bell, Clock } from 'lucide-react'
import { CHANNEL_CONFIG, SLA_CONFIG, PRIORITY_COLORS } from './constants'
import { isSupported as notificationsSupported, getPermission as getNotifPermission, requestPermission as requestNotifPermission } from '../../utils/notifications'

/** Small pure display components used across the Comms inbox — no external
 *  state, no closures over the parent. Each takes props and renders. */

/** Small bell button in the inbox header. Hides itself once permission has
 *  been resolved (granted or denied) — there's no useful action after that
 *  point. Browsers don't let JS un-grant; the user has to do it via site
 *  settings, which they'll know how to find if they want to. */
export function NotifPermissionButton() {
  const [permission, setPermission] = useState(notificationsSupported() ? getNotifPermission() : 'denied')
  if (!notificationsSupported() || permission !== 'default') return null
  return (
    <button
      onClick={async () => {
        const result = await requestNotifPermission()
        setPermission(result)
      }}
      title="Enable desktop notifications for new messages"
      className="w-8 h-8 rounded-xl bg-bg-2 hover:bg-bg-2 text-ink-2 flex items-center justify-center transition-colors"
    >
      <Bell className="w-4 h-4" />
    </button>
  )
}

/** Round initials avatar with a deterministic gradient palette per name.
 *  `online` renders a green presence dot bottom-right. */
export function Avatar({ name, size = 'md', className = '', online }) {
  const sizes = {
    xs: 'w-5 h-5 text-[9px]',
    sm: 'w-7 h-7 text-[10px]',
    md: 'w-9 h-9 text-xs',
    lg: 'w-11 h-11 text-sm',
    xl: 'w-14 h-14 text-base',
  }
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  const palettes = [
    'bg-gradient-to-br from-blue-400 to-indigo-600 text-white',
    'bg-gradient-to-br from-emerald-400 to-emerald-600 text-white',
    'bg-gradient-to-br from-violet-400 to-violet-600 text-white',
    'bg-gradient-to-br from-amber-400 to-amber-600 text-white',
    'bg-gradient-to-br from-rose-400 to-rose-600 text-white',
    'bg-gradient-to-br from-cyan-400 to-cyan-600 text-white',
    'bg-gradient-to-br from-indigo-400 to-indigo-600 text-white',
    'bg-gradient-to-br from-orange-400 to-orange-600 text-white',
  ]
  const hash = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return (
    <div className={`relative shrink-0 ${className}`}>
      <div className={`${sizes[size]} rounded-full flex items-center justify-center font-semibold shadow-sm ${palettes[hash % palettes.length]}`}>
        {initials}
      </div>
      {online && (
        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-panel" />
      )}
    </div>
  )
}

export function ChannelBadge({ channel, compact = false }) {
  const c = CHANNEL_CONFIG[channel] || CHANNEL_CONFIG.sms
  const Icon = c.icon
  if (compact) return <Icon className={`w-3.5 h-3.5 ${c.text}`} />
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${c.bg} ${c.text}`}>
      <Icon className="w-3 h-3" /> {c.label}
    </span>
  )
}

export function SlaBadge({ state, compact = false }) {
  // Phase 8: only render for the actionable state (breached → "Overdue").
  // The other states were noise — operators only need to know "this is late".
  if (state !== 'breached') return null
  const c = SLA_CONFIG.breached
  if (compact) {
    return (
      <span title="Overdue — needs reply" className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded"
        style={{ background: c.bg, color: c.text }}>
        <Clock className="w-2.5 h-2.5" /> Overdue
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
      style={{ background: c.bg, color: c.text }}>
      <Clock className="w-3 h-3" /> Overdue
    </span>
  )
}

export function PriorityDot({ priority }) {
  const p = PRIORITY_COLORS[priority]
  if (!p) return null
  return <span title={priority} className={`inline-block w-2 h-2 rounded-full ${p.dot}`} />
}

export function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center h-5 px-1.5 text-[10px] font-medium text-ink-3 bg-bg-2 border border-hairline rounded">
      {children}
    </kbd>
  )
}

export function DaySeparator({ label }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-bg-2" />
      <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-bg-2" />
    </div>
  )
}
