import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Menu, Search, Command, Zap, Sparkles, Plus, ChevronDown,
  Inbox, MessageSquare, CalendarDays, FileText, Users,
} from 'lucide-react'

const PAGE_TITLES = {
  '/dashboard': 'Home',
  '/workspace': 'Assistant',
  '/clients': 'Clients',
  '/requests': 'Requests',
  '/pipeline': 'Pipeline',
  '/billing': 'Quotes & Billing',
  '/schedule': 'Schedule',
  '/scheduling': 'Schedule',
  '/dispatch': 'Dispatch',
  '/payroll': 'Payroll',
  '/comms': 'Messages',
  '/properties': 'Properties',
  '/recurring': 'Recurring',
  '/owner': 'Owner',
  '/settings': 'Settings',
}

// The "+ New" quick-action menu — one tap from anywhere to start the work
// the app revolves around: a lead, a message, a job, a quote, or a client.
// Each item deep-links to the page that owns the create flow with the param
// that auto-opens its modal (?new=1 / ?compose=1), so the menu never has to
// mount those modals itself.
const NEW_ACTIONS = [
  { label: 'New lead',    icon: Inbox,          to: '/requests?new=1',           tint: 'text-indigo-600 dark:text-indigo-300',   bg: 'bg-indigo-50 dark:bg-indigo-500/15' },
  { label: 'New message', icon: MessageSquare,  to: '/comms?compose=1',          tint: 'text-blue-600 dark:text-blue-300',       bg: 'bg-blue-50 dark:bg-blue-500/15' },
  { label: 'New job',     icon: CalendarDays,   to: '/schedule?new=1',           tint: 'text-emerald-600 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-500/15' },
  { label: 'New quote',   icon: FileText,       to: '/billing?view=quotes&new=1', tint: 'text-purple-600 dark:text-purple-300',  bg: 'bg-purple-50 dark:bg-purple-500/15' },
  { label: 'New client',  icon: Users,          to: '/clients?new=1',            tint: 'text-amber-600 dark:text-amber-300',     bg: 'bg-amber-50 dark:bg-amber-500/15' },
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
        className="flex items-center gap-1.5 pl-2.5 pr-2 sm:pr-2.5 py-1.5 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-white font-semibold shadow-sm hover:shadow-md hover:opacity-95 transition-all"
        title="Create something new"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="w-4 h-4" />
        <span className="hidden sm:inline text-xs">New</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-52 bg-panel border border-hairline rounded-xl shadow-glass-lg py-1.5 z-50"
        >
          <p className="px-3 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-3">Create</p>
          {NEW_ACTIONS.map(a => (
            <button
              key={a.to}
              role="menuitem"
              onClick={() => { setOpen(false); navigate(a.to) }}
              className="w-full flex items-center gap-3 px-3 py-2 text-[13px] font-medium text-ink-2 hover:text-ink hover:bg-bg-2 transition-colors"
            >
              <span className={`grid place-items-center w-7 h-7 rounded-lg shrink-0 ${a.bg} ${a.tint}`}>
                <a.icon className="w-4 h-4" />
              </span>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Header({ onMenuToggle }) {
  const location = useLocation()
  const path = location.pathname
  const title = PAGE_TITLES[path] || 'BrightBase'

  return (
    <header className="no-print relative z-20 h-14 flex items-center justify-between px-4 sm:px-6 border-b border-hairline bg-panel/60 backdrop-blur-2xl shrink-0 shadow-sm">
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-2 -ml-2 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 active:bg-bg-2 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2.5 lg:hidden">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center shadow-md">
            <Zap className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-bold text-ink tracking-tight">{title}</span>
        </div>
        <h1 className="hidden lg:block text-base font-bold text-ink">{title}</h1>
      </div>

      <div className="flex items-center gap-2">
        {/* Create anything, from anywhere */}
        <NewMenu />
        {/* Global search — jump to any client/property/invoice/job (Cmd+/) */}
        <button
          onClick={() => {
            const event = new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true })
            window.dispatchEvent(event)
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-hairline bg-panel/50 hover:bg-panel/70 transition-all text-ink-3 hover:text-ink-2 shadow-sm"
          title="Search everything"
        >
          <Search className="w-4 h-4" />
          <span className="hidden sm:inline text-xs font-medium">Search</span>
          <div className="hidden sm:flex items-center gap-1 text-xs text-ink-3">
            <Command className="w-3 h-3" />
            <span>/</span>
          </div>
        </button>
        {/* AI assistant (Cmd+K) */}
        <button
          onClick={() => {
            const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            window.dispatchEvent(event)
          }}
          className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-hairline bg-panel/50 hover:bg-panel/70 transition-all text-ink-3 hover:text-ink-2 shadow-sm"
        >
          <Sparkles className="w-4 h-4" />
          <span className="text-xs font-medium">Ask AI</span>
          <div className="flex items-center gap-1 text-xs text-ink-3">
            <Command className="w-3 h-3" />
            <span>K</span>
          </div>
        </button>
      </div>
    </header>
  )
}
