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

// Phase 8 redesign: only the breached state is shown to operators (renamed
// "Overdue"). The intermediate met/on_track/at_risk states are kept in the
// data model but not rendered in the UI — they were jargon and added noise.
export const SLA_CONFIG = {
  met:      { bg: '#ecfdf5', text: '#047857', dot: '#10b981', label: 'Met' },
  on_track: { bg: '#eff6ff', text: '#1d4ed8', dot: '#3b82f6', label: 'On track' },
  at_risk:  { bg: '#fffbeb', text: '#b45309', dot: '#f59e0b', label: 'At risk' },
  breached: { bg: '#fef2f2', text: '#b91c1c', dot: '#ef4444', label: 'Overdue' },
}

export const CHANNEL_CONFIG = {
  sms:      { icon: Phone,          label: 'SMS',      bg: 'bg-emerald-50',  text: 'text-emerald-700', ring: 'ring-emerald-200' },
  email:    { icon: Mail,           label: 'Email',    bg: 'bg-blue-50',     text: 'text-blue-700',    ring: 'ring-blue-200' },
  chat:     { icon: MessageSquare,  label: 'Chat',     bg: 'bg-violet-50',   text: 'text-violet-700',  ring: 'ring-violet-200' },
  whatsapp: { icon: MessageSquare,  label: 'WhatsApp', bg: 'bg-green-50',    text: 'text-green-700',   ring: 'ring-green-200' },
}

export const PRIORITY_COLORS = {
  low:    { active: 'bg-bg-2 text-ink-2 ring-hairline-2', dot: 'bg-bg-2' },
  normal: { active: 'bg-blue-100 text-blue-700 ring-blue-300', dot: 'bg-blue-500' },
  high:   { active: 'bg-amber-100 text-amber-700 ring-amber-300', dot: 'bg-amber-500' },
  urgent: { active: 'bg-red-100 text-red-700 ring-red-300', dot: 'bg-red-500' },
}

export const TEAM_ASSIGNEES = ['Megan', 'Unassigned']
