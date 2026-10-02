import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { tabsForPath } from '../../nav/routes'

/**
 * SubNav — the second level of navigation.
 *
 * The sidebar lists the top-level destinations; the pages that live under one
 * are its tabs, and this is that strip. Drop `<SubNav />` under a page's header
 * and it works out which family the current route belongs to (`tabsForPath` in
 * nav/routes.js), filters to the tabs the current role can open, and renders
 * nothing for a leaf page or an unknown route.
 *
 * Everyday tabs render inline; the rarely-used power tabs (a tab marked
 * `secondary` in the manifest — Routes/Turnovers/Calendar sync, Deals/Quote
 * funnel, Tidy Up) fold under a quiet "More" so the common strip stays calm.
 * They're still one click away, still real <Link>s, and "More" itself shows
 * the active state when you're on one of them, so nothing hides silently.
 *
 * Look: quiet underline tabs — active is ink + a solid bottom border,
 * everything else is ink-3 that warms on hover. No pills, no fills, no counts
 * (design language: the owner has vetoed filled chips and count bubbles).
 */
export default function SubNav({ className = '' }) {
  const { pathname } = useLocation()
  const tabs = tabsForPath(pathname)
  const [moreOpen, setMoreOpen] = useState(false)
  // The dropdown is portalled to <body> and positioned from the button's rect.
  // It CANNOT live inside the nav: that strip is `overflow-x-auto` (so it
  // scrolls at phone width), and per spec overflow-x:auto also clips overflow-y,
  // which swallowed the dropdown whole — "More" opened but nothing showed.
  const [menuPos, setMenuPos] = useState(null)
  const moreRef = useRef(null)     // the button
  const menuRef = useRef(null)     // the portalled dropdown

  const openMore = () => {
    if (moreOpen) { setMoreOpen(false); return }
    const r = moreRef.current?.getBoundingClientRect()
    if (r) setMenuPos({ left: r.left, top: r.bottom + 4 })
    setMoreOpen(true)
  }

  useEffect(() => {
    if (!moreOpen) return
    const onDoc = (e) => {
      if (moreRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      setMoreOpen(false)
    }
    const onDismiss = () => setMoreOpen(false)   // scroll/resize detaches it
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
    }
  }, [moreOpen])

  // A single visible tab is just the page's own name — chrome for nothing.
  // Leaves (Messages, Money) return [] and land here too.
  if (tabs.length < 2) return null

  const isActive = (to) => pathname === to || pathname.startsWith(`${to}/`)
  const primary = tabs.filter(t => !t.secondary)
  const secondary = tabs.filter(t => t.secondary)
  const moreActive = secondary.some(t => isActive(t.to))

  const tabClass = (active) =>
    `shrink-0 whitespace-nowrap border-b-2 px-0.5 py-1.5 text-[13px] font-medium no-underline transition-colors ${
      active ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'
    }`

  return (
    <nav
      aria-label="Section"
      // Scrolls horizontally rather than wrapping or clipping at ~380px.
      className={`flex items-center gap-4 overflow-x-auto scrollbar-thin ${className}`}
    >
      {primary.map(tab => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={isActive(tab.to) ? 'page' : undefined}
          className={tabClass(isActive(tab.to))}
        >
          {tab.label}
        </Link>
      ))}

      {secondary.length > 0 && (
        <button
          type="button"
          ref={moreRef}
          onClick={openMore}
          aria-expanded={moreOpen}
          className={`shrink-0 inline-flex items-center gap-1 ${tabClass(moreActive)}`}
        >
          More <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
        </button>
      )}

      {moreOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', left: menuPos.left, top: menuPos.top }}
          className="z-50 min-w-[180px] rounded-lg border border-hairline bg-panel py-1 shadow-lg"
        >
          {secondary.map(tab => (
            <Link
              key={tab.to}
              to={tab.to}
              onClick={() => setMoreOpen(false)}
              aria-current={isActive(tab.to) ? 'page' : undefined}
              className={`block px-3 py-2 text-[13px] no-underline transition-colors ${
                isActive(tab.to) ? 'bg-bg-2 font-medium text-ink' : 'text-ink-2 hover:bg-bg-2'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>,
        document.body,
      )}
    </nav>
  )
}
