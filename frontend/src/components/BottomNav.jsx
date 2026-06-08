import { NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, Calendar, Receipt, CalendarCheck } from 'lucide-react'

const PRIMARY_TABS = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'Home' },
  { to: '/today',      icon: CalendarCheck,   label: 'Today' },
  { to: '/calendar',   icon: Calendar,        label: 'Calendar' },
  { to: '/clients',    icon: Users,           label: 'Clients' },
  { to: '/invoicing',  icon: Receipt,         label: 'Invoicing' },
]

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 lg:hidden bg-panel/95 backdrop-blur-md border-t border-hairline">
      <div className="flex items-stretch justify-around px-1" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {PRIMARY_TABS.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `
              flex flex-col items-center justify-center gap-0.5 py-2.5 px-3 flex-1 min-h-[3.25rem]
              transition-colors touch-none
              ${isActive ? 'text-blue-600' : 'text-ink-3 active:text-ink'}
            `}
          >
            {({ isActive }) => (
              <>
                <div className="relative">
                  <tab.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5px]' : 'stroke-[1.5px]'}`} />
                  {isActive && (
                    <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-5 h-0.5 rounded-full bg-blue-600" />
                  )}
                </div>
                <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : 'font-medium'}`}>
                  {tab.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
