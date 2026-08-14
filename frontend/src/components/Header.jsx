import { useState, useRef, useEffect, Fragment } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Menu, Search, Sparkles, Plus, ChevronDown, PanelLeft,
  Inbox, MessageSquare, CalendarDays, FileText, Users,
} from 'lucide-react'
import { crumbsFor } from '../nav/routes'

// The "+ New" quick-action menu — one tap from anywhere to start the work
// the app revolves around: a lead, a message, a job, a quote, or a client.
// Each item deep-links to the page that owns the create flow with the param
// that auto-opens its modal (?new=1 / ?compose=1), so the menu never has to
// mount those modals itself.
const NEW_ACTIONS = [
  { label: 'New lead',    icon: Inbox,         to: '/requests?new=1' },
  { label: 'New message', icon: MessageSquare, to: '/comms?compose=1' },
  { label: 'New job',     icon: CalendarDays,  to: '/schedule?new=1' },
  { label: 'New quote',   icon: FileText,      to: '/billing?view=quotes&new=1' },
  { label: 'New client',  icon: Users,         to: '/clients?new=1' },
]

function NewMenu() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex h-7 min-h-0 items-center gap-1 rounded-md bg-indigo-600 pl-2 pr-1.5 text-[12px] font-medium text-white transition-colors hover:bg-indigo-700"
        title="Create something new"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">New</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-48 rounded-lg border border-hairline-2 bg-panel py-1 shadow-glass-lg"
        >
          {NEW_ACTIONS.map(a => (
            <button
              key={a.to}
              role="menuitem"
              onClick={() => { setOpen(false); navigate(a.to) }}
              className="flex w-full min-h-0 items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2 hover:text-ink"
            >
              <a.icon className="h-4 w-4 shrink-0 text-ink-3" />
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Header — the slim 44px bar at the top of the content sheet. Left side is a
 * breadcrumb trail derived from the route manifest (nav/routes.js) — no more
 * hardcoded title map that left detail pages blank. Right side keeps the
 * global create/search/AI entry points, compact.
 */
export default function Header({ onMenuToggle, sidebarCollapsed, onSidebarExpand }) {
  const location = useLocation()
  const crumbs = crumbsFor(location.pathname)

  const openSearch = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))
  }
  const openAssistant = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  }

  return (
    <header className="no-print relative z-20 flex h-11 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-panel px-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* Mobile: open the drawer */}
        <button
          onClick={onMenuToggle}
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* Desktop: reopen the collapsed sidebar */}
        {sidebarCollapsed && (
          <button
            onClick={onSidebarExpand}
            title="Show sidebar"
            className="hidden h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2 lg:flex"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1
            return (
              <Fragment key={`${crumb.label}-${i}`}>
                {i > 0 && <span className="text-ink-3/60">/</span>}
                {crumb.to && !last ? (
                  <Link
                    to={crumb.to}
                    className="min-h-0 truncate rounded-sm px-1 py-0.5 text-ink-3 no-underline transition-colors hover:bg-bg-2 hover:text-ink-2"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={`truncate px-1 ${last ? 'font-medium text-ink' : 'text-ink-3'}`}>
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            )
          })}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Global search — jump to any client/property/invoice/job (⌘/) */}
        <button
          onClick={openSearch}
          className="flex h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2"
          title="Search everything (⌘/)"
        >
          <Search className="h-4 w-4" />
        </button>
        {/* AI assistant (⌘K) */}
        <button
          onClick={openAssistant}
          className="flex h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2"
          title="Ask AI (⌘K)"
        >
          <Sparkles className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-hairline-2" />
        <NewMenu />
      </div>
    </header>
  )
}
