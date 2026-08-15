import {
  LayoutDashboard, Sparkles, Users, Calendar, Receipt, LayoutGrid,
  DollarSign, MessageSquare, Home, Repeat, Settings, Inbox,
  TrendingUp, Radar, Rows3, Filter, HardHat, CalendarDays, FileText, Star,
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

/**
 * The global create actions — shared by the topbar "+ New" menu and the quick
 * switcher. Each deep-links to the page that owns the create flow with the
 * param that auto-opens its modal (?new=1 / ?compose=1), so neither consumer
 * has to mount those modals itself.
 */
export const CREATE_ACTIONS = [
  { label: 'New lead',    icon: Inbox,         to: '/requests?new=1',            keywords: 'create lead request intake' },
  { label: 'New message', icon: MessageSquare, to: '/comms?compose=1',           keywords: 'create message sms text compose' },
  { label: 'New job',     icon: CalendarDays,  to: '/schedule?new=1',            keywords: 'create job visit book schedule appointment' },
  { label: 'New quote',   icon: FileText,      to: '/billing?view=quotes&new=1', keywords: 'create quote estimate billing' },
  { label: 'New client',  icon: Users,         to: '/clients?new=1',             keywords: 'create client customer contact person' },
]

/** Every nav destination as a flat list (pages the switcher can jump to). */
export const NAV_ITEMS = [...NAV_SECTIONS.flatMap(s => s.items), SETTINGS_ITEM]

/** Best icon for a path: exact nav match, else the detail route's parent icon. */
export function iconFor(pathname) {
  const exact = NAV_ITEMS.find(i => i.to === pathname)
  if (exact) return exact.icon
  for (const d of DETAIL_ROUTES) {
    if (pathname.startsWith(d.prefix) && pathname.length > d.prefix.length) {
      return NAV_ITEMS.find(i => i.to === d.parent)?.icon || Star
    }
  }
  return Star
}

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
  // `record`: the backend record type for /api/ai/quick record context.
  // Absent (opportunities) = no backend type — recordFromPath skips it.
  { prefix: '/clients/',       parent: '/clients',    label: 'Client',   record: 'client' },
  { prefix: '/requests/',      parent: '/requests',   label: 'Request',  record: 'lead' },
  { prefix: '/opportunities/', parent: '/deals',      label: 'Deal' },
  { prefix: '/jobs/',          parent: '/schedule',   label: 'Job',      record: 'job' },
  { prefix: '/quotes/',        parent: '/billing',    label: 'Quote',    record: 'quote' },
  { prefix: '/invoices/',      parent: '/billing',    label: 'Invoice',  record: 'invoice' },
  { prefix: '/properties/',    parent: '/properties', label: 'Property', record: 'property' },
]

/**
 * Which record a detail page shows, for AI record context.
 * '/clients/12' -> { type: 'client', id: 12 }; list pages, sub-routes
 * (e.g. /properties/12/icals), and typeless details (deals) -> null.
 */
export function recordFromPath(pathname) {
  for (const d of DETAIL_ROUTES) {
    if (!d.record || !pathname.startsWith(d.prefix)) continue
    const rest = pathname.slice(d.prefix.length)
    if (/^\d+$/.test(rest)) return { type: d.record, id: Number(rest) }
  }
  return null
}

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
