/**
 * Design tokens for the Comms unified inbox and its extracted sub-components.
 * Pure constants — no React imports, no closures. Lucide icons for
 * CHANNEL_CONFIG are imported at the top so consumers just read the config
 * map.
 */
import { Phone, Mail, MessageSquare } from 'lucide-react'

export const COLORS = {
  primary: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
  surface: { 0: '#ffffff', 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7' },
  ink: { 900: '#18181b', 700: '#3f3f46', 500: '#71717a', 400: '#a1a1aa', 300: '#d4d4d8' },
}

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
