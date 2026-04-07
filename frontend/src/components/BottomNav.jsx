import { NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, Calendar, Receipt, Inbox, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'

const PRIMARY_TABS = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'Home' },
  { to: '/requests',   icon: Inbox,           label: 'Requests' },
  { to: '/scheduling', icon: Calendar,        label: 'Schedule' },
  { to: '/clients',    icon: Users,           label: 'Clients' },
  { to: '/invoicing',  icon: Receipt,         label: 'Invoicing' },
]

export default function BottomNav() {
  const location = useLocation()

  // Check if current path matches any primary tab
  const isOnPrimaryTab = PRIMARY_TABS.some(t => location.pathname.startsWith(t.to))

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-white/95 backdrop-blur-md border-t border-gray-200/80">
      <div className="flex items-stretch justify-around px-1" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {PRIMARY_TABS.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `
              flex flex-col items-center justify-center gap-0.5 py-2 px-3 flex-1
              transition-colors touch-none
              ${isActive
                ? 'text-gray-900'
                : 'text-gray-400 active:text-gray-600'
              }
            `}
          >
            {({ isActive }) => (
              <>
                <div className={`relative ${isActive ? '' : ''}`}>
                  <tab.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5px]' : 'stroke-[1.5px]'}`} />
                  {isActive && (
                    <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-5 h-0.5 rounded-full bg-gray-900" />
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
