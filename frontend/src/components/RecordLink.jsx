import { Link } from 'react-router-dom'
import { Building2, FileText, Receipt, Calendar, TrendingUp, MapPin } from 'lucide-react'

/**
 * One canonical way to link to any record, so references look and behave
 * identically across the app (Twenty's "everything links together"). Renders an
 * inline link (optional type icon + label); falls back to plain text when there's
 * no id to link to, so it's safe to drop in anywhere.
 *
 * Props:
 *   type    – 'client' | 'quote' | 'job' | 'invoice' | 'opportunity' | 'property'
 *   id      – record id
 *   label   – text to show (required)
 *   icon    – show the type's default icon (default false)
 *   className – extra classes on the link/text
 */
const ROUTES = {
  client: (id) => `/clients/${id}`,
  quote: (id) => `/quotes/${id}`,
  job: (id) => `/jobs/${id}`,
  invoice: (id) => `/invoices/${id}`,
  opportunity: (id) => `/opportunities/${id}`,
  property: (id) => `/properties/${id}`,
}

const ICONS = {
  client: Building2,
  quote: FileText,
  job: Calendar,
  invoice: Receipt,
  opportunity: TrendingUp,
  property: MapPin,
}

export default function RecordLink({ type, id, label, icon = false, className = '', onClick }) {
  const Icon = icon ? ICONS[type] : null
  const text = label ?? (id != null ? `#${id}` : '—')
  const to = id != null && ROUTES[type] ? ROUTES[type](id) : null

  if (!to) {
    return <span className={`text-ink-2 ${className}`}>{text}</span>
  }
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-blue-500 hover:underline truncate ${className}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="truncate">{text}</span>
    </Link>
  )
}
