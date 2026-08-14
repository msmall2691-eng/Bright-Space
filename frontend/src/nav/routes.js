import {
  LayoutDashboard, Sparkles, Users, Calendar, Receipt, LayoutGrid,
  DollarSign, MessageSquare, Home, Repeat, Settings, Inbox,
  TrendingUp, Radar, Rows3, Filter, HardHat,
} from 'lucide-react'

/**
 * The single route manifest — one place that knows every page's label, icon,
 * section, and role gate. Feeds the Sidebar nav, the topbar breadcrumbs, and
 * (eventually) the quick switcher, replacing the old duplicated `nav` array
 * in Sidebar.jsx and the hardcoded PAGE_TITLES map in Header.jsx.
 *
 * `roles`: when present, only those roles see the item (matches the backend's
 * gates — e.g. /api/dashboard/owner 403s viewers, so viewers don't get a link
 * that only errors).
 */
export const NAV_SECTIONS = [
  {
    label: null,
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
      { to: '/workspace', icon: Sparkles,        label: 'Assistant' },
      { to: '/owner',     icon: TrendingUp,      label: 'Owner', roles: ['admin', 'manager'] },
    ],
  },
  {
    label: 'Sales',
    items: [
      { to: '/deals',    icon: Rows3,      label: 'Deals' },
      { to: '/requests', icon: Inbox,      label: 'Requests' },
      { to: '/pipeline', icon: LayoutGrid, label: 'Pipeline' },
      { to: '/funnel',   icon: Filter,     label: 'Quote funnel', roles: ['admin', 'manager'] },
      { to: '/billing',  icon: Receipt,    label: 'Quotes & Billing' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { to: '/comms',      icon: MessageSquare, label: 'Messages' },
      { to: '/clients',    icon: Users,         label: 'Clients' },
      { to: '/properties', icon: Home,          label: 'Properties' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/schedule',  icon: Calendar, label: 'Schedule' },
      { to: '/recurring', icon: Repeat,   label: 'Recurring' },
      { to: '/sync',      icon: Radar,    label: 'Sync', roles: ['admin', 'manager', 'viewer'] },
    ],
  },
  {
    label: 'Team',
    items: [
      { to: '/crew',    icon: HardHat,    label: 'Crew', roles: ['admin', 'manager'] },
      { to: '/payroll', icon: DollarSign, label: 'Payroll' },
    ],
  },
]

/** Settings lives in the sidebar footer, not a nav section. */
export const SETTINGS_ITEM = { to: '/settings', icon: Settings, label: 'Settings' }

/** Flat lookup: path -> { label, section } for breadcrumbs. */
const FLAT = new Map()
for (const section of NAV_SECTIONS) {
  for (const item of section.items) FLAT.set(item.to, { label: item.label, section: section.label })
}
FLAT.set('/settings', { label: 'Settings', section: null })

/**
 * Detail routes: prefix -> the parent list page + a generic record label.
 * Pages own their record's real name; the crumb just orients ("Clients /
 * Client"), which beats the old header's blank 'BrightBase' fallback.
 */
const DETAIL_ROUTES = [
  { prefix: '/clients/',       parent: '/clients',    label: 'Client' },
  { prefix: '/requests/',      parent: '/requests',   label: 'Request' },
  { prefix: '/opportunities/', parent: '/deals',      label: 'Deal' },
  { prefix: '/jobs/',          parent: '/schedule',   label: 'Job' },
  { prefix: '/quotes/',        parent: '/billing',    label: 'Quote' },
  { prefix: '/invoices/',      parent: '/billing',    label: 'Invoice' },
  { prefix: '/properties/',    parent: '/properties', label: 'Property' },
]

/** Routes reachable outside the nav (redirect targets, internal pages). */
const EXTRA_ROUTES = {
  '/dashboard/classic': { label: 'Classic dashboard', section: null },
  '/cleanup':           { label: 'Tidy Up', section: null },
  '/design-system':     { label: 'Design system', section: null },
}

/**
 * Resolve the breadcrumb trail for a pathname.
 * Returns [{ label, to? }] — last entry is the current page (no link).
 */
export function crumbsFor(pathname) {
  const exact = FLAT.get(pathname) || EXTRA_ROUTES[pathname]
  if (exact) {
    return exact.section
      ? [{ label: exact.section }, { label: exact.label }]
      : [{ label: exact.label }]
  }
  for (const d of DETAIL_ROUTES) {
    if (pathname.startsWith(d.prefix) && pathname.length > d.prefix.length) {
      const parent = FLAT.get(d.parent)
      return [{ label: parent?.label || d.label, to: d.parent }, { label: d.label }]
    }
  }
  return [{ label: 'BrightBase' }]
}
