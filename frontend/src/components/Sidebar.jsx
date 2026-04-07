import { useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, FileText, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox,
  ChevronRight
} from 'lucide-react'

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workspace',   icon: Sparkles,        label: 'Workspace' },
  { divider: true, label: 'Clients' },
  { to: '/clients',     icon: Users,           label: 'Clients' },
  { to: '/requests',    icon: Inbox,           label: 'Requests' },
  { to: '/quoting',     icon: FileText,        label: 'Quoting' },
  { to: '/invoicing',   icon: Receipt,         label: 'Invoicing' },
  { to: '/comms',       icon: MessageSquare,   label: 'Comms' },
  { divider: true, label: 'Scheduling' },
  { to: '/scheduling',  icon: Calendar,        label: 'Schedule' },
  { to: '/recurring',   icon: Repeat,          label: 'Recurring' },
  { to: '/properties',  icon: Home,            label: 'Properties' },
  { divider: true, label: 'Team' },
  { to: '/dispatch',    icon: Send,            label: 'Dispatch' },
  { to: '/payroll',     icon: DollarSign,      label: 'Payroll' },
  { divider: true, label: 'System' },
  { to: '/settings',    icon: Settings,        label: 'Settings' },
]

export default function Sidebar({ open, onClose }) {
  const location = useLocation()

  useEffect(() => { onClose() }, [location.pathname])

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-50 w-[260px] sm:w-[220px] bg-[#FAFAFA] border-r border-gray-200/80
        flex flex-col shrink-0 transform transition-transform duration-200 ease-in-out
        lg:static lg:translate-x-0 lg:w-[220px]
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo area */}
        <div className="h-12 sm:h-14 flex items-center justify-between px-4 border-b border-gray-200/60">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-gray-900 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <div>
              <span className="text-[13px] font-semibold text-gray-900 tracking-tight leading-none">BrightBase</span>
              <p className="text-[10px] text-gray-400 leading-none mt-0.5">Maine Cleaning Co.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 active:bg-gray-200 transition-colors touch-none"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-1.5 overflow-y-auto scroll-smooth-mobile">
          {nav.map((item, i) =>
            item.divider ? (
              <div key={i} className="px-4 pt-5 pb-1">
                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-[0.08em]">{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `group flex items-center gap-2.5 px-3 py-2.5 sm:py-[7px] mx-2 my-[1px] rounded-md transition-all text-[13px] select-none-interactive ${
                    isActive
                      ? 'bg-gray-900 text-white font-medium'
                      : 'text-gray-600 hover:bg-gray-100 active:bg-gray-200 hover:text-gray-900'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white/80' : 'text-gray-400 group-hover:text-gray-500'}`} />
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            )
          )}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200/60">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center">
              <span className="text-[10px] font-medium text-gray-500">M</span>
            </div>
            <span className="text-[12px] text-gray-500 truncate">Megan</span>
          </div>
        </div>
      </aside>
    </>
  )
}
