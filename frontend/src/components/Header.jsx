import { useLocation } from 'react-router-dom'
import { Menu, Search, Command, Zap, Sparkles } from 'lucide-react'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/workspace': 'Workspace',
  '/clients': 'Clients',
  '/requests': 'Requests',
  '/pipeline': 'Pipeline',
  '/billing': 'Billing',
  '/schedule': 'Schedule',
  '/scheduling': 'Schedule',
  '/dispatch': 'Dispatch',
  '/payroll': 'Payroll',
  '/comms': 'Comms',
  '/properties': 'Properties',
  '/recurring': 'Recurring',
  '/settings': 'Settings',
}

export default function Header({ onMenuToggle }) {
  const location = useLocation()
  const path = location.pathname
  const title = PAGE_TITLES[path] || 'BrightBase'

  return (
    <header className="h-14 flex items-center justify-between px-4 sm:px-6 border-b border-hairline bg-panel/80 backdrop-blur-lg shrink-0 shadow-sm">
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-2 -ml-2 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 active:bg-bg-2 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2.5 lg:hidden">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-md">
            <Zap className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-bold text-ink tracking-tight">{title}</span>
        </div>
        <h1 className="hidden lg:block text-base font-bold text-ink">{title}</h1>
      </div>

      <div className="flex items-center gap-2">
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
