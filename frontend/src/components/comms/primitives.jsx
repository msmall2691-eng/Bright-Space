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

/** Round initials avatar. Twenty-CRM style: flat, low-saturation tint per
 *  name (soft background + same-hue ink, no gradient, no shadow) so a full
 *  inbox reads as one calm surface instead of a bag of skittles. `online`
 *  renders a green presence dot bottom-right. */
export function Avatar({ name, size = 'md', className = '', online }) {
  const sizes = {
    xs: 'w-5 h-5 text-[9px]',
    sm: 'w-7 h-7 text-[10px]',
    md: 'w-9 h-9 text-xs',
    lg: 'w-11 h-11 text-sm',
    xl: 'w-14 h-14 text-base',
  }
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  // Muted, desaturated tints — deliberately quiet. Dark mode uses a low-alpha
  // wash of the same hue so avatars don't glow against the dark panel.
  const palettes = [
    'bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300',
    'bg-stone-100 text-stone-600 dark:bg-stone-400/15 dark:text-stone-300',
    'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
    'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    'bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
    'bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
    'bg-teal-100 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300',
  ]
  const hash = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return (
    <div className={`relative shrink-0 ${className}`}>
      <div className={`${sizes[size]} rounded-full flex items-center justify-center font-semibold ${palettes[hash % palettes.length]}`}>
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
  // Token-based (dark-mode aware) rather than the inline SLA_CONFIG hex, which
  // baked in a light-only red that read harsh on the dark panel.
  const tone = 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300'
  if (compact) {
    return (
      <span title="Overdue — needs reply" className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded ${tone}`}>
        <Clock className="w-2.5 h-2.5" /> Overdue
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${tone}`}>
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
      <div className="flex-1 h-px bg-hairline" />
      <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-hairline" />
    </div>
  )
}
