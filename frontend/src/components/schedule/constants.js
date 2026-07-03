/**
 * Shared constants + tiny helpers for the Schedule page and its extracted
 * sub-components. Everything here is closure-free — pure values or pure
 * functions with no captured state.
 */
import { Wind, Home, Building2 } from 'lucide-react'

// Property type colors (STR = amber, residential = blue, commercial = purple)
export const PROPERTY_TYPE_CONFIG = {
  str:         { color: 'bg-amber-50 border-l-4 border-l-amber-400', badge: 'bg-amber-100 text-amber-700',   icon: Wind,       label: 'STR' },
  residential: { color: 'bg-blue-50 border-l-4 border-l-blue-400',   badge: 'bg-blue-100 text-blue-700',     icon: Home,       label: 'Residential' },
  commercial:  { color: 'bg-purple-50 border-l-4 border-l-purple-400', badge: 'bg-purple-100 text-purple-700', icon: Building2, label: 'Commercial' },
}

export const VISIT_STATUS_CONFIG = {
  scheduled:   { label: 'Scheduled',   dot: 'bg-blue-500',   badge: 'info',    pillMobile: 'bg-blue-50 text-blue-700' },
  dispatched:  { label: 'Dispatched',  dot: 'bg-green-500',  badge: 'success', pillMobile: 'bg-green-50 text-green-700' },
  en_route:    { label: 'En Route',    dot: 'bg-cyan-500',   badge: 'info',    pillMobile: 'bg-cyan-50 text-cyan-700' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500',  badge: 'warning', pillMobile: 'bg-amber-50 text-amber-700' },
  completed:   { label: 'Completed',   dot: 'bg-green-600',  badge: 'success', pillMobile: 'bg-emerald-50 text-emerald-700' },
  no_show:     { label: 'No Show',     dot: 'bg-red-500',    badge: 'danger',  pillMobile: 'bg-red-50 text-red-700' },
  cancelled:   { label: 'Cancelled',   dot: 'bg-ink-3',      badge: 'danger',  pillMobile: 'bg-bg-2 text-ink-2' },
}

export const VISIT_ACCENT = {
  str: 'border-l-amber-400',
  str_turnover: 'border-l-amber-400',
  residential: 'border-l-blue-400',
  commercial: 'border-l-purple-400',
}

export const DEFAULT_CHECKLIST = [
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'bathrooms', label: 'Bathrooms' },
  { key: 'bedrooms', label: 'Bedrooms' },
  { key: 'living_areas', label: 'Living areas' },
  { key: 'linens', label: 'Linens changed' },
  { key: 'trash', label: 'Trash out' },
]

/** "Jun 5" style date label for booking check-in/out timestamps. */
export const shortDate = (iso) => {
  if (!iso) return ''
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    })
  } catch { return iso }
}

/** First initials of the first two whitespace-separated words in a name. */
export const cleanerInitials = (name) =>
  (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'
