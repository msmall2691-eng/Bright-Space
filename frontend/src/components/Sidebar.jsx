import { useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, FileText, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox,
  ChevronRight, Bell, Building2, LayoutGrid,
} from 'lucide-react'

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/work',        icon: LayoutGrid,      label: 'Work' },
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
          className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-50 w-[240px] bg-zinc-950 border-r border-zinc-800
        flex flex-col shrink-0 transform transition-transform duration-200 ease-in-out
        lg:static lg:translate-x-0 lg:w-[220px]
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo area */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <div>
              <span className="text-[13px] font-semibold text-white tracking-tight leading-none">BrightBase</span>
              <p className="text-[10px] text-zinc-500 leading-none mt-0.5">Maine Cleaning Co.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {nav.map((item, i) =>
            item.divider ? (
              <div key={i} className="px-4 pt-5 pb-1.5">
                <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `group flex items-center gap-2.5 px-3 py-[7px] mx-2 my-[1px] rounded-lg transition-all text-[13px] select-none ${
                    isActive
                      ? 'bg-zinc-800 text-white font-medium'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-400' : 'text-zinc-600 group-hover:text-zinc-400'}`} />
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            )
          )}
        </nav>

        {/* Footer / user */}
        <div className="px-3 py-3 border-t border-zinc-800/60">
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-zinc-900 transition-colors cursor-pointer">
            <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center">
              <span className="text-[11px] font-semibold text-blue-400">M</span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[12px] text-zinc-300 font-medium truncate block">Megan</span>
              <span className="text-[10px] text-zinc-600 truncate block">Owner</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
