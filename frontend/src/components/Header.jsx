import { useLocation } from 'react-router-dom'
import { Menu, Search, Command, Zap } from 'lucide-react'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/workspace': 'Workspace',
  '/clients': 'Clients',
  '/requests': 'Requests',
  '/pipeline': 'Pipeline',
  '/quoting': 'Quoting',
  '/scheduling': 'Schedule',
  '/invoicing': 'Invoicing',
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
    <header className="h-14 flex items-center justify-between px-4 sm:px-6 border-b border-white/10 bg-white/80 backdrop-blur-lg shrink-0 shadow-sm">
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-2 -ml-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2.5 lg:hidden">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-md">
            <Zap className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-bold text-neutral-900 tracking-tight">{title}</span>
        </div>
        <h1 className="hidden lg:block text-base font-bold text-neutral-900">{title}</h1>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            window.dispatchEvent(event)
          }}
          className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-neutral-200/50 bg-white/50 hover:bg-white/70 transition-all text-neutral-500 hover:text-neutral-700 shadow-sm"
        >
          <Search className="w-4 h-4" />
          <span className="text-xs font-medium">Ask AI</span>
          <div className="flex items-center gap-1 text-xs text-neutral-400">
            <Command className="w-3 h-3" />
            <span>K</span>
          </div>
        </button>
      </div>
    </header>
  )
}
