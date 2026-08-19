import { Link, useLocation } from 'react-router-dom'
import { tabsForPath } from '../../nav/routes'

/**
 * SubNav — the second level of navigation.
 *
 * The sidebar lists seven destinations, not seventeen (Aug 2026 collapse).
 * The pages that left the rail didn't go anywhere: each one is a tab on its
 * parent, and this is that strip. Drop `<SubNav />` under a page's header and
 * it works out which family the current route belongs to (`tabsForPath` in
 * nav/routes.js), filters the tabs the current role can actually open, and
 * renders nothing at all for a leaf page or an unknown route.
 *
 * Look: quiet underline tabs — the same vocabulary as the Messages filter
 * strip (`components/client/MessagesTab.jsx`) and ClientProfile's tabs.
 * Active is ink + a solid bottom border; everything else is ink-3 that warms
 * on hover. No pills, no fills, no counts (design language: the owner has
 * vetoed filled chips and count bubbles three separate times).
 *
 * Every tab is a real <Link>, so middle-click / ⌘-click / "open in new tab"
 * behave like links, not like JS handlers.
 */
export default function SubNav({ className = '' }) {
  const { pathname } = useLocation()
  const tabs = tabsForPath(pathname)

  // A single visible tab is just the page's own name — that's chrome for
  // nothing. Leaves (Messages, Money) return [] and land here too.
  if (tabs.length < 2) return null

  return (
    <nav
      aria-label="Section"
      // Scrolls horizontally rather than wrapping or clipping at ~380px.
      className={`flex items-center gap-4 overflow-x-auto scrollbar-thin ${className}`}
    >
      {tabs.map(tab => {
        const active = pathname === tab.to || pathname.startsWith(`${tab.to}/`)
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap border-b-2 px-0.5 py-1.5 text-[13px] font-medium no-underline transition-colors ${
              active
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
