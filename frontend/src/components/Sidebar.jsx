import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, FileText, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox,
  ChevronRight, Bell, Building2, LayoutGrid, LogOut, ChevronDown,
} from 'lucide-react'
import { logout } from '../api'

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workspace',   icon: Sparkles,        label: 'Workspace' },
  { divider: true, label: 'Sales Pipeline' },
  { to: '/requests',    icon: Inbox,           label: 'Requests' },
  { to: '/quoting',     icon: FileText,        label: 'Quoting' },
  { to: '/invoicing',   icon: Receipt,         label: 'Invoicing' },
  { divider: true, label: 'Operations' },
  { to: '/clients',     icon: Users,           label: 'Clients' },
  { to: '/schedule',    icon: Calendar,        label: 'Schedule' },
  { to: '/properties',  icon: Home,            label: 'Properties' },
  { to: '/comms',       icon: MessageSquare,   label: 'Comms' },
  { divider: true, label: 'Team' },
  { to: '/payroll',     icon: DollarSign,      label: 'Payroll' },
  { divider: true, label: 'Settings' },
  { to: '/settings',    icon: Settings,        label: 'Settings' },
]

export default function Sidebar({ open, onClose, user }) {
  const location = useLocation()
  const [showUserMenu, setShowUserMenu] = useState(false)

  useEffect(() => {
    onClose()
    setShowUserMenu(false)
  }, [location.pathname])

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-50 w-[260px]
        bg-white/90 backdrop-blur-lg border-r border-white/20
        flex flex-col shrink-0 transform transition-transform duration-200 ease-in-out
        lg:static lg:translate-x-0 lg:w-[260px]
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo area */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-md">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[14px] font-bold text-neutral-900 tracking-tight leading-none block">BrightBase</span>
              <p className="text-[11px] text-neutral-500 leading-none mt-0.5">Maine Cleaning</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto scrollbar-thin">
          {nav.map((item, i) =>
            item.divider ? (
              <div key={i} className="px-4 pt-6 pb-2">
                <span className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider">{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `group flex items-center gap-3 px-3 py-2.5 mx-2 my-0.5 rounded-lg transition-all text-[13px] select-none font-medium ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`w-5 h-5 shrink-0 ${isActive ? 'text-white' : 'text-neutral-400 group-hover:text-blue-600'}`} />
                    <span className="truncate flex-1">{item.label}</span>
                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white"></div>}
                  </>
                )}
              </NavLink>
            )
          )}
        </nav>

        {/* Footer / user */}
        <div className="px-3 py-3 border-t border-white/10">
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-neutral-100 transition-all text-left group"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-md">
                <span className="text-[12px] font-bold text-white">
                  {user?.email?.[0]?.toUpperCase() || 'A'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[12px] text-neutral-900 font-semibold truncate block">
                  {user?.email?.split('@')[0] || 'Admin'}
                </span>
                <span className="text-[10px] text-neutral-500 truncate block capitalize">
                  {user?.role || 'User'}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-white/95 backdrop-blur-lg border border-white/20 rounded-lg shadow-glass py-1 z-50">
                <button
                  onClick={() => {
                    setShowUserMenu(false)
                    logout()
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12px] text-neutral-600 hover:text-red-600 hover:bg-red-50 transition-colors font-medium"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Log out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
