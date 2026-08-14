import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Calendar, MessageSquare, Inbox, Menu } from 'lucide-react'
import { useUnreadCount } from '../hooks/useUnreadCount'

// The thumb-reachable tabs map to the three pillars the business runs on —
// Leads, Messages, Schedule — with Home leading and "More" opening the full
// menu. Everything else (Clients, Billing, Pipeline, Recurring, Properties,
// Payroll, Owner, Settings) is one tap away under "More".
const PRIMARY_TABS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { to: '/requests',  icon: Inbox,           label: 'Requests' },
  { to: '/comms',     icon: MessageSquare,   label: 'Messages', badgeKey: 'comms' },
  { to: '/schedule',  icon: Calendar,        label: 'Schedule' },
]

function TabInner({ Icon, label, isActive, badge }) {
  return (
    <>
      <div className="relative">
        <Icon className={`w-[22px] h-[22px] ${isActive ? 'stroke-[2.4px]' : 'stroke-[1.6px]'}`} />
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-red-500 text-white text-[9px] font-bold ring-2 ring-panel">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </div>
      <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : 'font-medium'}`}>{label}</span>
    </>
  )
}

export default function BottomNav() {
  // Plain read — no onIncrease, so this instance never chimes/notifies (that
  // stays in the sidebar's poller). One extra lightweight poll every 2 min.
  const { unreadConversations } = useUnreadCount()

  const openMenu = () => window.dispatchEvent(new Event('bb:open-menu'))

  return (
    <nav className="no-print fixed bottom-0 left-0 right-0 z-30 lg:hidden bg-panel/95 backdrop-blur-md border-t border-hairline"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="flex items-stretch justify-around px-1">
        {PRIMARY_TABS.map(tab => (
          <NavLink key={tab.to} to={tab.to}
            className={({ isActive }) =>
              `relative flex flex-col items-center justify-center gap-1 py-2 px-2 flex-1 min-h-[3.5rem] no-underline transition-colors ${
                isActive ? 'text-indigo-600' : 'text-ink-3 active:text-ink'}`}>
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-indigo-600" />}
                <TabInner Icon={tab.icon} label={tab.label} isActive={isActive}
                  badge={tab.badgeKey === 'comms' ? unreadConversations : 0} />
              </>
            )}
          </NavLink>
        ))}
        {/* "More" opens the full menu (drawer). App listens for bb:open-menu. */}
        <button onClick={openMenu}
          className="relative flex flex-col items-center justify-center gap-1 py-2 px-2 flex-1 min-h-[3.5rem] text-ink-3 active:text-ink transition-colors">
          <Menu className="w-[22px] h-[22px] stroke-[1.6px]" />
          <span className="text-[10px] leading-tight font-medium">More</span>
        </button>
      </div>
    </nav>
  )
}
