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
    <header className="h-12 sm:h-14 flex items-center justify-between px-3 sm:px-6 border-b border-gray-200/60 bg-white shrink-0">
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Mobile: menu button + logo */}
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-2 -ml-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors touch-none"
        >
          <Menu className="w-5 h-5" />
        </button>
        {/* Mobile: show logo inline since sidebar is hidden */}
        <div className="flex items-center gap-2 lg:hidden">
          <div className="w-5 h-5 rounded-md bg-gray-900 flex items-center justify-center">
            <Zap className="w-3 h-3 text-white" />
          </div>
          <span className="text-sm font-semibold text-gray-900 tracking-tight">{title}</span>
        </div>
        {/* Desktop: just the title */}
        <h1 className="hidden lg:block text-[15px] font-semibold text-gray-900">{title}</h1>
      </div>

      <div className="flex items-center gap-2">
        {/* AI search button */}
        <button
          onClick={() => {
            const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            window.dispatchEvent(event)
          }}
          className="flex items-center gap-2 px-3 py-2 sm:py-1.5 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 active:bg-gray-200 transition-colors text-gray-400 hover:text-gray-500 touch-none"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="text-xs hidden sm:inline">Ask AI</span>
          <div className="hidden sm:flex items-center gap-0.5 text-[10px] text-gray-300">
            <Command className="w-2.5 h-2.5" />
            <span>K</span>
          </div>
        </button>
      </div>
    </header>
  )
}
