import { useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Sparkles, Users, FileText, Calendar, Receipt,
  Send, DollarSign, MessageSquare, Zap, Home, Repeat, Settings, X, Inbox
} from 'lucide-react'

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard',   desc: 'Overview' },
  { to: '/workspace',   icon: Sparkles,        label: 'Workspace',   desc: 'Agent hub' },
  { divider: true, label: 'CLIENTS' },
  { to: '/clients',     icon: Users,           label: 'Clients',     desc: 'CRM' },
  { to: '/requests',    icon: Inbox,           label: 'Requests',    desc: 'Incoming leads' },
  { to: '/quoting',     icon: FileText,        label: 'Quoting',     desc: 'Quotes' },
  { to: '/invoicing',   icon: Receipt,         label: 'Invoicing',   desc: 'Billing' },
  { to: '/comms',       icon: MessageSquare,   label: 'Comms',       desc: 'SMS / Email' },
  { divider: true, label: 'SCHEDULING' },
  { to: '/scheduling',  icon: Calendar,        label: 'Schedule',    desc: 'All jobs' },
  { to: '/recurring',   icon: Repeat,          label: 'Recurring',   desc: 'Weekly / monthly' },
  { to: '/properties',  icon: Home,            label: 'STR Props',   desc: 'Airbnb turnovers' },
  { divider: true, label: 'TEAM' },
  { to: '/dispatch',    icon: Send,            label: 'Dispatch',    desc: 'Connecteam' },
  { to: '/payroll',     icon: DollarSign,      label: 'Payroll',     desc: 'Timesheets' },
  { divider: true, label: 'SETTINGS' },
  { to: '/settings',    icon: Settings,        label: 'Fields',      desc: 'Custom fields' },
]

export default function Sidebar({ open, onClose }) {
  const location = useLocation()

  // Close sidebar on route change (mobile)
  useEffect(() => {
    if (open) onClose()
  }, [location.pathname])

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-gray-950 flex flex-col shrink-0 transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 lg:w-52 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Logo */}
        <div className="px-5 py-5 border-b border-white/[0.06] flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-white/10 rounded-lg flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <span className="text-[15px] font-semibold text-white tracking-tight">BrightBase</span>
            </div>
            <p className="text-[10px] text-white/30 mt-1.5 ml-9">The Maine Cleaning Co.</p>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-2 overflow-y-auto scrollbar-thin -webkit-overflow-scrolling-touch">
          {nav.map((item, i) =>
            item.divider ? (
              <div key={i} className="px-5 pt-5 pb-1.5">
                <span className="text-[9px] font-semibold text-white/25 tracking-[0.15em] uppercase">{item.label}</span>
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 mx-2 rounded-lg transition-all text-sm ${
                    isActive
                      ? 'bg-white/10 text-white'
                      : 'text-white/40 hover:text-white/80 hover:bg-white/[0.05]'
                  }`
                }
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="font-medium">{item.label}</span>
              </NavLink>
            )
          )}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/[0.06]">
          <p className="text-[10px] text-white/20">BrightBase v1.0</p>
        </div>
      </aside>
    </>
  )
}
