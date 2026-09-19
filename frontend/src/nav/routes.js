import {
  LayoutDashboard, Sparkles, Users, Calendar, Receipt,
  DollarSign, MessageSquare, Home, Repeat, Settings, Inbox,
  TrendingUp, Radar, Rows3, Filter, HardHat, Store, CalendarDays, FileText, Star,
  GitMerge, Route, CalendarClock, FileCheck,
} from 'lucide-react'

/**
 * The single route manifest — one place that knows every page's label, icon,
 * section, and role gate. Feeds the Sidebar nav, the sub-nav tab strips, the
 * topbar breadcrumbs, and the quick switcher.
 *
 * SHAPE (Aug 2026 "7 destinations" nav collapse):
 * The sidebar used to list 17 destinations under 5 group labels, which the
 * owner called "chaos". It now lists SEVEN, ungrouped — six nav rows plus
 * Settings in the footer. Nothing was deleted: every page that left the
 * sidebar became a `tabs` entry on its parent, rendered as a quiet underline
 * strip under that page's header (`components/ui/SubNav.jsx`). So the
 * hierarchy is one level deeper, not smaller, and every old URL still
 * resolves exactly as before.
 *
 * Per item:
 *  - `label`  — what the SIDEBAR row says ("Sales", "Money").
 *  - `tabs`   — the sub-nav strip for this destination, ALWAYS starting with
 *               the parent's own page. A tab's `label` is what the STRIP and
 *               the breadcrumb/switcher say ("Deals", "Billing"), which is why
 *               a parent can read as "Sales" in the rail and "Deals" on the
 *               page. Omit `tabs` for a leaf (Messages, Money) — SubNav then
 *               renders nothing.
 *  - `pageLabel` — breadcrumb/switcher label for a leaf whose sidebar label is
 *               a category name (Money → "Billing").
 *  - `roles`  — when present, only those roles see the item (matches the
 *               backend's gates — e.g. /api/dashboard/owner 403s viewers, so
 *               viewers don't get a link that only errors). Role gates live on
 *               the tab that owns the page, unchanged from the old flat list.
 *
 * Pipeline was merged into Deals (Aug 2026 nav simplification) as its Board
 * view — `/deals?view=board` — instead of a separate page/route, so it has
 * no entry here and no breadcrumb of its own; `/pipeline` now just redirects
 * to that URL (see App.jsx) for old bookmarks/links.
 */
// The rows are ordered to read top-to-bottom like the business's own line —
// a lead comes in, becomes a client, gets scheduled, gets invoiced — with
// Crew (who does the work) after it and Settings in the footer:
//   Home · Messages · Leads · Clients · Schedule · Money · Crew
// Labels use ONE word per concept (owner's "stop the confusing doubles"):
// "Leads" (not Requests/Intake), "Crew" (not Marketplace/Bench). Routes are
// unchanged — only the sidebar labels and order moved — so every old URL and
// bookmark still resolves.
export const NAV_SECTIONS = [
  {
    label: null,
    items: [
      {
        to: '/dashboard', icon: LayoutDashboard, label: 'Home',
        tabs: [
          { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
          { to: '/workspace', icon: Sparkles,       label: 'Assistant', keywords: 'ai chat nova mia scout' },
          { to: '/owner',     icon: TrendingUp,     label: 'Owner', roles: ['admin', 'manager'], keywords: 'revenue mrr close rate' },
        ],
      },
      // All /api/comms endpoints (and the crew-chat office side) are
      // admin/manager-only. No tabs — Messages is a leaf.
      { to: '/comms', icon: MessageSquare, label: 'Messages', roles: ['admin', 'manager'], keywords: 'sms email inbox texts crew chat' },
      {
        // The start of the line: everything coming IN — website requests, the
        // quotes you send, and the ones they accepted. "Leads" is the one word
        // for it (was "Requests"/"Sales"); the incoming list is still the
        // landing tab. Quotes/Accepted/Deals/Funnel stay a tab away. Gated
        // admin/manager (the whole intake/sales surface already is).
        to: '/requests', icon: Inbox, label: 'Leads', roles: ['admin', 'manager'],
        tabs: [
          { to: '/requests',        icon: Inbox,     label: 'New', keywords: 'requests sales leads intake website inbox incoming' },
          { to: '/quotes',          icon: FileText,  label: 'Quotes', keywords: 'quotes estimates pricing proposals' },
          // The "said yes, still needs booking" set — accepted quotes not yet
          // converted to a scheduled job. Same page, pre-filtered.
          { to: '/quotes/accepted', icon: FileCheck, label: 'Accepted', keywords: 'accepted won ready to schedule book' },
          { to: '/deals',           icon: Rows3,     label: 'Deals', keywords: 'sales pipeline opportunities board' },
          { to: '/funnel',          icon: Filter,    label: 'Quote funnel', keywords: 'sales conversion close rate' },
        ],
      },
      {
        to: '/clients', icon: Users, label: 'Clients',
        tabs: [
          { to: '/clients',    icon: Users, label: 'Clients', keywords: 'customers contacts' },
          { to: '/properties', icon: Home,  label: 'Properties', keywords: 'homes rentals sites str' },
          // Tidy Up was orphaned: a working duplicate-client / duplicate-
          // property merge tool reachable only from one buried link in
          // Settings → General. It cleans up clients and properties, so it
          // belongs beside them — /api/cleanup is admin/manager-only.
          { to: '/cleanup', icon: GitMerge, label: 'Tidy Up', roles: ['admin', 'manager'],
            keywords: 'duplicates merge cleanup tidy dedupe' },
        ],
      },
      {
        to: '/schedule', icon: Calendar, label: 'Schedule',
        tabs: [
          { to: '/schedule',  icon: Calendar, label: 'Schedule', keywords: 'jobs calendar dispatch' },
          // Every /api/recurring endpoint is admin/manager-only.
          { to: '/recurring', icon: Repeat,   label: 'Recurring', roles: ['admin', 'manager'], keywords: 'series weekly biweekly' },
          // Routes group recurring houses into one sub's standing day. Office-only:
          // every /api/routes endpoint is admin/manager (the crew side lives in
          // the crew app, on /api/crew/my-routes).
          { to: '/routes',    icon: Route,    label: 'Routes', roles: ['admin', 'manager'], keywords: 'block standing subcontractor owner day' },
          // Guest changeover days staffed as a batch. Office-only, like the
          // rest of this family — the crew side is the ordinary open board.
          { to: '/turnovers', icon: CalendarClock, label: 'Turnovers', roles: ['admin', 'manager'], keywords: 'saturday changeover str airbnb window price step' },
          // Renamed from "Sync" — plain enough in context, but "Calendar sync"
          // reads unambiguously on first glance for a non-technical owner.
          { to: '/sync',      icon: Radar,    label: 'Calendar sync', roles: ['admin', 'manager', 'viewer'], keywords: 'google ical feeds turnovers' },
        ],
      },
      // Money is invoices + payments now — quotes moved to the Leads hub, so
      // this stays a leaf with no strip (Invoicing owns its own internal views).
      { to: '/billing', icon: Receipt, label: 'Money', pageLabel: 'Billing', keywords: 'money invoices payments billing dunning' },
      {
        // Who does the work — the subcontractor bench, one word: "Crew" (was
        // "Marketplace", which read as jargon). Overview (waiting-on-you / open
        // jobs / the front door), the Roster (add cleaners, vetting), and
        // Payouts a tab each. Only office roles; a solo owner not dispatching to
        // subs can mostly ignore it.
        to: '/marketplace', icon: HardHat, label: 'Crew', roles: ['admin', 'manager'],
        tabs: [
          { to: '/marketplace', icon: Store,      label: 'Overview', roles: ['admin', 'manager'], keywords: 'bench subcontractors marketplace open jobs applicants apply' },
          { to: '/crew',        icon: HardHat,    label: 'Roster', roles: ['admin', 'manager'], keywords: 'crew team cleaners subs bench roster invite applicants vetting documents insurance' },
          { to: '/payroll',     icon: DollarSign, label: 'Payouts', roles: ['admin', 'manager'], keywords: 'pay subcontractors payouts ledger 1099 stripe direct deposit' },
        ],
      },
    ],
  },
]

/**
 * Settings lives in the sidebar footer, not a nav section — but it's the
 * seventh destination and carries the Team pages as tabs (Crew and Payroll
 * are both "set up the people who work here", which is what Settings is).
 */
export const SETTINGS_ITEM = {
  to: '/settings', icon: Settings, label: 'Settings',
  // A leaf now. Crew and Payouts used to hang here on the reasoning that both
  // are "set up the people who work here" — true under the employee model,
  // wrong under this one. They are the bench's day-to-day surfaces, so they
  // moved to Marketplace. Listing them in both places would be worse than
  // either: a nav where the same page appears twice teaches you to distrust
  // the nav.
}

/** Every top-level sidebar destination (six rows + Settings in the footer). */
const TOP_LEVEL = [...NAV_SECTIONS.flatMap(s => s.items), SETTINGS_ITEM]

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
  { label: 'New quote',   icon: FileText,      to: '/quotes?new=1',              keywords: 'create quote estimate billing' },
  { label: 'New client',  icon: Users,         to: '/clients?new=1',             keywords: 'create client customer contact person' },
]

/**
 * Every nav destination as a flat list (pages the switcher can jump to) —
 * all 16, exactly as before the collapse. Tabs are destinations too; the
 * quick switcher and Favorites must still reach a page that no longer has a
 * sidebar row of its own. Labels here are the PAGE labels ("Deals", not
 * "Sales"); `keywords` keeps the sidebar wording ("sales", "money")
 * searchable.
 */
export const NAV_ITEMS = (() => {
  const seen = new Set()
  const out = []
  for (const item of TOP_LEVEL) {
    const entries = item.tabs || [{
      to: item.to, icon: item.icon, label: item.pageLabel || item.label,
      roles: item.roles, keywords: item.keywords,
    }]
    for (const e of entries) {
      if (seen.has(e.to)) continue
      seen.add(e.to)
      // A tab is only reachable if its parent is: inherit the parent's gate
      // when the tab doesn't declare its own (today only Messages/Money gate
      // at the parent, and both are leaves — this is belt-and-braces).
      out.push({ ...e, roles: e.roles || item.roles })
    }
  }
  return out
})()

/** The current user's role, read the same way the rest of the shell does. */
export function currentRole() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.role || null }
  catch { return null }
}

const visibleTo = (role) => (i) => !i.roles || (role && i.roles.includes(role))

/** Nav destinations visible to a role — same filter the Sidebar applies, for
 *  the quick switcher (a viewer shouldn't be offered pages that only 403). */
export function navItemsFor(role) {
  return NAV_ITEMS.filter(visibleTo(role))
}

/** Sidebar rows visible to a role (top-level only — six + Settings). */
export function sidebarSectionsFor(role) {
  return NAV_SECTIONS
    .map(section => ({ ...section, items: section.items.filter(visibleTo(role)) }))
    .filter(section => section.items.length > 0)
}

/** Create actions visible to a role. Every create flow (lead, message, job,
 *  quote, client) is an admin/manager write in the backend, so viewers get
 *  none — the "+ New" menu and switcher hide rather than offer 403s. */
export function createActionsFor(role) {
  return role === 'admin' || role === 'manager' ? CREATE_ACTIONS : []
}

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

/**
 * The sub-nav strip for a pathname: the sibling pages that share its
 * top-level destination, role-filtered. Returns [] for a leaf (Messages,
 * Money) or an unknown/detail path, so `<SubNav />` renders nothing there.
 * Detail pages resolve through their list parent (/properties/12 → the
 * Clients strip) — harmless today because no detail page mounts SubNav, and
 * correct if one ever does.
 */
export function tabsForPath(pathname, role = currentRole()) {
  const parent = TOP_LEVEL.find(i =>
    i.tabs?.some(t => t.to === pathname || pathname.startsWith(`${t.to}/`))
  )
  if (!parent) return []
  return parent.tabs.filter(visibleTo(role))
}

/** Flat lookup: path -> { label, section } for breadcrumbs. */
const FLAT = new Map()
for (const item of TOP_LEVEL) {
  // The parent's own page gets no section crumb ("Home", not "Home / Home").
  FLAT.set(item.to, { label: item.tabs?.[0]?.label || item.pageLabel || item.label, section: null })
  for (const tab of item.tabs || []) {
    if (tab.to === item.to) continue
    FLAT.set(tab.to, { label: tab.label, section: item.label })
  }
}

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
  { prefix: '/quotes/',        parent: '/quotes',     label: 'Quote',    record: 'quote' },
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
