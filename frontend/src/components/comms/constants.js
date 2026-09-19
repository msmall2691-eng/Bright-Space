/**
 * Design tokens for the Comms unified inbox and its extracted sub-components.
 * Pure constants — no React imports, no closures. Lucide icons for
 * CHANNEL_CONFIG are imported at the top so consumers just read the config
 * map.
 */
import { Phone, Mail, MessageSquare } from 'lucide-react'

// Channel + priority indicators are dot+word, not filled/tinted chips (owner's
// veto of pill bubbles) — each config entry carries a solid dot color class
// plus a plain-text label; consumers render a small colored dot next to
// `text-ink-2`/`text-ink-3` text instead of a tinted background.
export const CHANNEL_CONFIG = {
  sms:      { icon: Phone,          label: 'SMS',      dot: 'bg-emerald-500' },
  email:    { icon: Mail,           label: 'Email',    dot: 'bg-blue-500' },
  chat:     { icon: MessageSquare,  label: 'Chat',     dot: 'bg-violet-500' },
  whatsapp: { icon: MessageSquare,  label: 'WhatsApp', dot: 'bg-green-500' },
}

export const PRIORITY_COLORS = {
  low:    { dot: 'bg-ink-3' },
  normal: { dot: 'bg-blue-500' },
  high:   { dot: 'bg-amber-500' },
  urgent: { dot: 'bg-red-500' },
}

export const TEAM_ASSIGNEES = ['Megan', 'Unassigned']
