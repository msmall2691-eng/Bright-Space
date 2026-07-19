import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox, Clock,
  ChevronRight, Bell, Building2, LayoutGrid, LogOut, ChevronDown, TrendingUp,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { logout } from '../api'

// Navigation reorganized around the three pillars the business runs on:
// Leads (win the work), Customers (talk to them), and Scheduling (get it
// done). Home + the AI Assistant sit up top; Team and Settings anchor the
// bottom. Owner Dashboard is admin/manager-only (backend 403s viewers on
// /api/dashboard/owner) — the `roles` gate below hides the link for
// viewer/cleaner accounts so they don't see a route that only 403s.
const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Home' },
  { to: '/owner',       icon: TrendingUp,      label: 'Owner',       roles: ['admin', 'manager'] },
  { to: '/workspace',   icon: Sparkles,        label: 'Assistant' },
  { divider: true, label: 'Leads' },
  { to: '/requests',    icon: Inbox,           label: 'Requests' },
  { to: '/pipeline',    icon: LayoutGrid,      label: 'Pipeline' },
  { to: '/billing',     icon: Receipt,         label: 'Quotes & Billing' },
  { divider: true, label: 'Customers' },
  { to: '/comms',       icon: MessageSquare,   label: 'Messages' },
  { to: '/clients',     icon: Users,           label: 'Clients' },
  { to: '/properties',  icon: Home,            label: 'Properties' },
  { divider: true, label: 'Scheduling' },
  { to: '/schedule',    icon: Calendar,        label: 'Schedule' },
  { to: '/recurring',   icon: Repeat,          label: 'Recurring' },
  { divider: true, label: 'Team' },
  { to: '/payroll',     icon: DollarSign,      label: 'Payroll' },
  { to: '/connecteam',  icon: Clock,           label: 'Connecteam' },
  { divider: true, label: 'Settings' },
  { to: '/settings',    icon: Settings,        label: 'Settings' },
]

export default function Sidebar({ open, onClose, user, badges = {} }) {
  const location = useLocation()
  const [showUserMenu, setShowUserMenu] = useState(false)
  // Icon-rail collapse (desktop only) — persisted so it sticks between visits.
  // The mobile drawer always shows full labels.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('bb_sidebar_collapsed') === '1' } catch { return false }
  })
  const toggleCollapsed = () => setCollapsed(c => {
    try { localStorage.setItem('bb_sidebar_collapsed', c ? '0' : '1') } catch { /* ignore */ }
    return !c
  })

  useEffect(() => {
    onClose()
    setShowUserMenu(false)
  }, [location.pathname, onClose])

  // When collapsed the rail hides labels; the mobile drawer (`open`) always
  // shows them, so labels are hidden only at lg+ when collapsed.
  const labelHide = collapsed ? 'lg:hidden' : ''

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
        no-print
        fixed inset-y-0 left-0 z-50 w-[260px]
        bg-panel/95 backdrop-blur-lg border-r border-hairline
        flex flex-col shrink-0 transform transition-[transform,width] duration-200 ease-in-out
        lg:static lg:translate-x-0 ${collapsed ? 'lg:w-[68px]' : 'lg:w-[260px]'}
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo area */}
        <div className={`h-16 flex items-center border-b border-hairline ${collapsed ? 'lg:justify-center lg:px-2 px-4 justify-between' : 'justify-between px-4'}`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="bb-glow-accent w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center shadow-md shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className={`flex-1 min-w-0 ${labelHide}`}>
              <span className="text-[14px] font-bold text-ink tracking-tight leading-none block">BrightBase</span>
              <p className="text-[11px] text-ink-3 leading-none mt-0.5">Maine Cleaning</p>
            </div>
          </div>
          {/* Desktop collapse toggle */}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden lg:flex p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors ${collapsed ? 'lg:hidden' : ''}`}
          >
            <PanelLeftClose className="w-[18px] h-[18px]" />
          </button>
          {/* Mobile drawer close */}
          <button
            onClick={onClose}
            className="lg:hidden p-2 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* When collapsed, a small expand affordance sits at the top of the nav */}
        {collapsed && (
          <button
            onClick={toggleCollapsed}
            title="Expand sidebar"
            className="hidden lg:flex mx-auto mt-2 p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <PanelLeftOpen className="w-[18px] h-[18px]" />
          </button>
        )}

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden scrollbar-thin">
          {nav
            .filter(item => !item.roles || (user?.role && item.roles.includes(user.role)))
            .map((item, i) =>
            item.divider ? (
              <div key={i} className={collapsed ? 'lg:mx-3 lg:my-2 lg:border-t lg:border-hairline px-4 pt-3.5 pb-1 lg:pt-6 lg:pb-2' : 'px-4 pt-3.5 pb-1 lg:pt-6 lg:pb-2'}>
                <span className={`text-[11px] font-bold text-ink-3 uppercase tracking-wider ${labelHide}`}>{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 px-3 py-2.5 lg:py-2 mx-2 my-0.5 rounded-lg transition-colors text-[13px] select-none ${collapsed ? 'lg:justify-center lg:px-0 lg:mx-2' : ''} ${
                    isActive
                      ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-semibold'
                      : 'text-ink-2 font-medium hover:text-ink hover:bg-bg-2/70'
                  }`
                }
              >
                {({ isActive }) => {
                  const badge = badges[item.to]
                  return (
                    <>
                      {/* Twenty-style: a thin accent rail marks the active item
                          instead of a saturated blue fill. */}
                      {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-indigo-600" />}
                      <span className="relative shrink-0">
                        <item.icon className={`w-[18px] h-[18px] ${isActive ? 'text-indigo-600' : 'text-ink-3 group-hover:text-ink-2'}`} />
                        {/* Collapsed: badge shrinks to a dot on the icon corner */}
                        {badge > 0 && collapsed && (
                          <span className="hidden lg:block absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-panel" />
                        )}
                      </span>
                      <span className={`truncate flex-1 ${labelHide}`}>{item.label}</span>
                      {badge > 0 && (
                        <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold bg-red-500 text-white ${labelHide}`}>
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
              title={collapsed ? (user?.email?.split('@')[0] || 'Account') : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-2 transition-all text-left group ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-md">
                <span className="text-[12px] font-bold text-white">
                  {user?.email?.[0]?.toUpperCase() || 'A'}
                </span>
              </div>
              <div className={`flex-1 min-w-0 ${labelHide}`}>
                <span className="text-[12px] text-ink font-semibold truncate block">
                  {user?.email?.split('@')[0] || 'Admin'}
                </span>
                <span className="text-[10px] text-ink-3 truncate block capitalize">
                  {user?.role || 'User'}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''} ${labelHide}`} />
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-panel/95 backdrop-blur-lg border border-hairline rounded-lg shadow-glass py-1 z-50 min-w-[160px]">
                <button
                  onClick={() => {
                    setShowUserMenu(false)
                    logout()
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12px] text-ink-2 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors font-medium"
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
