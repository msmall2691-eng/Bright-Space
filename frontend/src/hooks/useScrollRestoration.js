import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Restore the scroll position of a specific scroll container across history
 * navigation. React Router's <ScrollRestoration> only works with a data router
 * (createBrowserRouter); this app uses <BrowserRouter> + <Routes>, so we do it
 * by hand against the real scrolling element (the office <main>, not window).
 *
 * The behaviour people expect on a phone:
 *   - Tap a job in a long Schedule/Clients list, hit Back → land where you were.
 *   - Open a new page forward → start at the top.
 *   - Switch an in-page tab (?view=/?tab=, same pathname) → don't jump at all.
 *
 * Positions are keyed by `location.key` (stable per history entry, reused on a
 * POP), kept in a module-level map so they survive the component remounts the
 * page-fade causes. Restoring retries for a short window because the list's
 * real height only exists after its data has loaded — a single synchronous set
 * would land on a page that's still one screen tall.
 */

const positions = new Map() // location.key -> scrollTop

export function useScrollRestoration(ref) {
  const location = useLocation()
  const navType = useNavigationType() // 'POP' | 'PUSH' | 'REPLACE'
  const prevPath = useRef(location.pathname)

  // Remember where this history entry was scrolled to (rAF-throttled).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const key = location.key
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        positions.set(key, el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, location.key])

  // On navigation: restore (Back/Forward) or reset to top (new page). An
  // in-page switch that keeps the same pathname is left exactly where it is.
  useEffect(() => {
    const el = ref.current
    if (!el) {
      prevPath.current = location.pathname
      return
    }
    const samePath = location.pathname === prevPath.current
    prevPath.current = location.pathname
    if (samePath) return

    // scrollTop assignment can inherit CSS `scroll-behavior: smooth`, which
    // would animate the jump; force it instant while we place the position.
    const prevBehavior = el.style.scrollBehavior
    el.style.scrollBehavior = 'auto'

    if (navType === 'POP' && positions.has(location.key)) {
      const target = positions.get(location.key)
      let tries = 0
      let raf = 0
      const restore = () => {
        el.scrollTop = target
        tries += 1
        // Keep nudging until it sticks (content grew tall enough) or the
        // window closes (~1s) so a short page can't trap us in a loop.
        if (Math.abs(el.scrollTop - target) > 2 && tries < 60) {
          raf = requestAnimationFrame(restore)
        } else {
          el.style.scrollBehavior = prevBehavior
        }
      }
      raf = requestAnimationFrame(restore)
      return () => { if (raf) cancelAnimationFrame(raf) }
    }

    el.scrollTop = 0
    el.style.scrollBehavior = prevBehavior
  }, [ref, location.key, location.pathname, navType])
}
