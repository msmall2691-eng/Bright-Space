import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Calendar, MessageSquare, Inbox, Menu } from 'lucide-react'
import { useUnreadCount } from '../hooks/useUnreadCount'

// The thumb-reachable tabs map to the three pillars the business runs on —
// Leads, Messages, Schedule — with Home leading and "More" opening the full
// menu. Everything else (Clients, Billing, Pipeline, Recurring, Properties,
// Payroll, Owner, Settings) is one tap away under "More".
//
// Messages badges BOTH inboxes (client conversations + crew chat), so crew
// chat is two taps from anywhere on a phone: Messages → Crew.
//
// `roles` mirrors the backend gates (intake + comms are admin/manager-only):
// a viewer's tabs are just Home / Schedule / More instead of entries that 403.
const PRIMARY_TABS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { to: '/requests',  icon: Inbox,           label: 'Requests', roles: ['admin', 'manager'] },
  { to: '/comms',     icon: MessageSquare,   label: 'Messages', badgeKey: 'comms', roles: ['admin', 'manager'] },
  { to: '/schedule',  icon: Calendar,        label: 'Schedule' },
]

function TabInner({ Icon, label, isActive, badge }) {
  return (
    <>
      <div className="relative">
        <Icon className={`w-[22px] h-[22px] ${isActive ? 'stroke-[2.4px]' : 'stroke-[1.6px]'}`} />
        {/* Unread = quiet dot + plain bold number (design law: no red bubbles). */}
        {badge > 0 && (
          <span className="absolute -top-1 -right-3 flex items-center gap-0.5" aria-label={`${badge} unread`}>
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" aria-hidden="true" />
            <span className="text-[9px] font-bold tabular-nums text-ink-2 leading-none">
              {badge > 99 ? '99+' : badge}
            </span>
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
  const { unreadConversations, crewUnreadThreads } = useUnreadCount()
  const messagesBadge = unreadConversations + crewUnreadThreads

  // Same role source the rest of the shell uses (App.jsx reads it the same
  // way); cleaner accounts never render this nav at all (they get My Day).
  let role = null
  try { role = JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.role || null } catch { /* ignore */ }
  const tabs = PRIMARY_TABS.filter(t => !t.roles || (role && t.roles.includes(role)))

  const openMenu = () => window.dispatchEvent(new Event('bb:open-menu'))

  return (
    <nav className="no-print fixed bottom-0 left-0 right-0 z-30 shell:hidden bg-panel/95 backdrop-blur-md border-t border-hairline"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="flex items-stretch justify-around px-1">
        {tabs.map(tab => (
          <NavLink key={tab.to} to={tab.to}
            className={({ isActive }) =>
              `relative flex flex-col items-center justify-center gap-1 py-2 px-2 flex-1 min-h-[3.5rem] no-underline transition-colors ${
                isActive ? 'text-indigo-600' : 'text-ink-3 active:text-ink'}`}>
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-indigo-600" />}
                <TabInner Icon={tab.icon} label={tab.label} isActive={isActive}
                  badge={tab.badgeKey === 'comms' ? messagesBadge : 0} />
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
