import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox,
  ChevronRight, Bell, Building2, LayoutGrid, LogOut, ChevronDown,
} from 'lucide-react'
import { logout } from '../api'

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workspace',   icon: Sparkles,        label: 'Workspace' },
  { divider: true, label: 'Sales' },
  { to: '/requests',    icon: Inbox,           label: 'Requests' },
  { to: '/pipeline',    icon: LayoutGrid,      label: 'Pipeline' },
  { to: '/billing',     icon: Receipt,         label: 'Billing' },
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

export default function Sidebar({ open, onClose, user, badges = {} }) {
  const location = useLocation()
  const [showUserMenu, setShowUserMenu] = useState(false)

  useEffect(() => {
    onClose()
    setShowUserMenu(false)
  }, [location.pathname, onClose])

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
        bg-panel/95 backdrop-blur-lg border-r border-hairline
        flex flex-col shrink-0 transform transition-transform duration-200 ease-in-out
        lg:static lg:translate-x-0 lg:w-[260px]
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo area */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-hairline">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center shadow-md">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[14px] font-bold text-ink tracking-tight leading-none block">BrightBase</span>
              <p className="text-[11px] text-ink-3 leading-none mt-0.5">Maine Cleaning</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto scrollbar-thin">
          {nav.map((item, i) =>
            item.divider ? (
              <div key={i} className="px-4 pt-6 pb-2">
                <span className="text-[11px] font-bold text-ink-3 uppercase tracking-wider">{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 px-3 py-2 mx-2 my-0.5 rounded-md transition-colors text-[13px] select-none ${
                    isActive
                      ? 'bg-bg-2 text-ink font-semibold'
                      : 'text-ink-2 font-medium hover:text-ink hover:bg-bg-2/60'
                  }`
                }
              >
                {({ isActive }) => {
                  const badge = badges[item.to]
                  return (
                    <>
                      {/* Twenty-style: a thin accent rail marks the active item
                          instead of a saturated blue fill. */}
                      {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-blue-600" />}
                      <item.icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-blue-600' : 'text-ink-3 group-hover:text-ink-2'}`} />
                      <span className="truncate flex-1">{item.label}</span>
                      {badge > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold bg-red-500 text-white">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </>
                  )
                }}
              </NavLink>
            )
          )}
        </nav>

        {/* Footer / user */}
        <div className="px-3 py-3 border-t border-hairline">
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-2 transition-all text-left group"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-md">
                <span className="text-[12px] font-bold text-white">
                  {user?.email?.[0]?.toUpperCase() || 'A'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[12px] text-ink font-semibold truncate block">
                  {user?.email?.split('@')[0] || 'Admin'}
                </span>
                <span className="text-[10px] text-ink-3 truncate block capitalize">
                  {user?.role || 'User'}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-panel/95 backdrop-blur-lg border border-hairline rounded-lg shadow-glass py-1 z-50">
                <button
                  onClick={() => {
                    setShowUserMenu(false)
                    logout()
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12px] text-ink-2 hover:text-red-600 hover:bg-red-50 transition-colors font-medium"
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
