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
  sms:      { icon: Phone,          label: 'SMS',      bg: 'bg-emerald-50 dark:bg-emerald-500/15',  text: 'text-emerald-700 dark:text-emerald-300', ring: 'ring-emerald-200 dark:ring-emerald-500/30' },
  email:    { icon: Mail,           label: 'Email',    bg: 'bg-blue-50 dark:bg-blue-500/15',     text: 'text-blue-700 dark:text-blue-300',    ring: 'ring-blue-200 dark:ring-blue-500/30' },
  chat:     { icon: MessageSquare,  label: 'Chat',     bg: 'bg-violet-50 dark:bg-violet-500/15',   text: 'text-violet-700 dark:text-violet-300',  ring: 'ring-violet-200 dark:ring-violet-500/30' },
  whatsapp: { icon: MessageSquare,  label: 'WhatsApp', bg: 'bg-green-50 dark:bg-green-500/15',    text: 'text-green-700 dark:text-green-300',   ring: 'ring-green-200 dark:ring-green-500/30' },
}

export const PRIORITY_COLORS = {
  low:    { active: 'bg-bg-2 text-ink-2 ring-hairline-2', dot: 'bg-bg-2' },
  normal: { active: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 ring-blue-300 dark:ring-indigo-500/30', dot: 'bg-blue-500' },
  high:   { active: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 ring-amber-300 dark:ring-amber-500/30', dot: 'bg-amber-500' },
  urgent: { active: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300 ring-red-300 dark:ring-red-500/30', dot: 'bg-red-500' },
}

export const TEAM_ASSIGNEES = ['Megan', 'Unassigned']
