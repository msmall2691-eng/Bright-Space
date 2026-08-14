/**
 * Recently visited pages/records — feeds the quick switcher's empty state.
 * Recorded from App on every route change; capped, deduped by path, newest
 * first, persisted in localStorage. Labels come from the page's own <h1>
 * (read after the page has had a moment to render — RecordShell and list
 * pages both title themselves there), falling back to the breadcrumb label,
 * so a client's page shows as "Sarah Coleman", not "Client".
 */
import { crumbsFor } from './routes'

const KEY = 'bb_recents'
const MAX = 12
const SKIP = new Set(['/login', '/'])

export function getRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(r => r && r.to && r.label) : []
  } catch {
    return []
  }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))) } catch { /* ignore */ }
}

/** Call on route change. Reads the page h1 after a short settle delay. */
export function recordVisit(pathname) {
  if (SKIP.has(pathname) || pathname.startsWith('/portal') || pathname.startsWith('/accept-invite')) return
  const timer = setTimeout(() => {
    const h1 = document.querySelector('main h1')?.textContent?.trim()
    const crumbs = crumbsFor(pathname)
    const label = h1 || crumbs[crumbs.length - 1]?.label || pathname
    if (!label || label === 'BrightBase') return
    save([{ to: pathname, label }, ...getRecents().filter(r => r.to !== pathname)])
  }, 800)
  return () => clearTimeout(timer)
}
