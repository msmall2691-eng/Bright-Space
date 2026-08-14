import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Zap, X, LogOut, ChevronDown, PanelLeftClose, Search, Sparkles,
} from 'lucide-react'
import { logout } from '../api'
import { NAV_SECTIONS, SETTINGS_ITEM } from '../nav/routes'
import Kbd from './ui/Kbd'

/**
 * Sidebar — the quiet Notion/Twenty-style nav. It sits directly on the app
 * frame (no panel background, no border on desktop); the content "sheet" to
 * its right provides the contrast. Always fully labeled on desktop — the old
 * 76px icon rail + hover-peek machinery is gone (one owner using this daily
 * shouldn't have to re-discover nav by hovering). `collapsed` hides it
 * entirely; the topbar shows a reopen button (state lives in App.jsx so both
 * can see it). Mobile keeps the slide-in drawer + backdrop.
 */

// Row shell shared by nav items and the Search/Ask AI system rows: compact on
// desktop (the base layer's 44px touch min-height is relaxed via lg:min-h-8),
// full touch size on mobile.
const ROW =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 lg:py-1 lg:min-h-[30px] text-[13px] select-none no-underline transition-colors duration-100'

function SystemRow({ icon: Icon, label, hint, onClick }) {
  return (
    <button onClick={onClick} className={`${ROW} font-medium text-ink-2 hover:bg-bg-3/70 hover:text-ink`}>
      <Icon className="h-4 w-4 shrink-0 text-ink-3" />
      <span className="flex-1 truncate text-left">{label}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </button>
  )
}

function NavRow({ item, badge }) {
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `${ROW} ${
          isActive
            ? 'bg-bg-3 font-semibold text-ink'
            : 'font-medium text-ink-2 hover:bg-bg-3/70 hover:text-ink'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-ink' : 'text-ink-3'}`} />
          <span className="flex-1 truncate">{item.label}</span>
          {badge > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              <span className="text-[11px] font-semibold tabular-nums text-ink-3">
                {badge > 99 ? '99+' : badge}
              </span>
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

export default function Sidebar({ open, onClose, collapsed, onCollapse, user, badges = {} }) {
  const location = useLocation()
  const [showUserMenu, setShowUserMenu] = useState(false)

  useEffect(() => {
    onClose()
    setShowUserMenu(false)
  }, [location.pathname, onClose])

  const openSearch = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))
  }
  const openAssistant = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  }

  const visibleSections = NAV_SECTIONS.map(section => ({
    ...section,
    items: section.items.filter(item => !item.roles || (user?.role && item.roles.includes(user.role))),
  })).filter(section => section.items.length > 0)

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          no-print fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col
          border-r border-hairline bg-panel
          transition-transform duration-200 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full'}
          lg:static lg:z-auto lg:w-60 lg:translate-x-0 lg:border-r-0 lg:bg-transparent
          ${collapsed ? 'lg:hidden' : 'lg:flex'}
        `}
      >
        {/* Workspace row */}
        <div className="flex h-12 shrink-0 items-center justify-between pl-3.5 pr-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink">
              <Zap className="h-3.5 w-3.5 text-bg" />
            </div>
            <span className="truncate text-[13px] font-semibold tracking-tight text-ink">BrightBase</span>
          </div>
          {/* Desktop: collapse. Mobile: close drawer. */}
          <button
            onClick={onCollapse}
            title="Hide sidebar"
            className="hidden h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-3/70 hover:text-ink-2 lg:flex"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2 lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* System rows */}
        <div className="shrink-0 space-y-px px-2 pb-1">
          <SystemRow icon={Search} label="Search" hint="⌘/" onClick={openSearch} />
          <SystemRow icon={Sparkles} label="Ask AI" hint="⌘K" onClick={openAssistant} />
        </div>

        {/* Navigation */}
        <nav className="scrollbar-thin flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
          {visibleSections.map((section, i) => (
            <div key={section.label || i} className={section.label ? 'mt-5' : 'mt-1'}>
              {section.label && (
                <p className="px-2.5 pb-1 text-[11px] font-medium text-ink-3">{section.label}</p>
              )}
              <div className="space-y-px">
                {section.items.map(item => (
                  <NavRow key={item.to} item={item} badge={badges[item.to]} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer: Settings + user */}
        <div className="shrink-0 space-y-px border-t border-hairline px-2 py-2 lg:border-t-0 lg:pt-0">
          <NavRow item={SETTINGS_ITEM} />
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(v => !v)}
              className={`${ROW} group text-left hover:bg-bg-3/70`}
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-3 text-[11px] font-bold text-ink-2">
                {user?.email?.[0]?.toUpperCase() || 'A'}
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-ink">
                  {user?.email?.split('@')[0] || 'Admin'}
                </span>
                <span className="block truncate text-[10px] capitalize leading-tight text-ink-3">
                  {user?.role || 'User'}
                </span>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-ink-3 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-1.5 min-w-[160px] rounded-lg border border-hairline-2 bg-panel py-1 shadow-glass">
                <button
                  onClick={() => { setShowUserMenu(false); logout() }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4" />
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
