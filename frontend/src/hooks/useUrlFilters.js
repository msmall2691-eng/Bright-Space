import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Filter state that lives in the URL.
 *
 * Why: a filter held in `useState` cannot be linked to, bookmarked, or survive
 * a reload. That is fine for a transient toggle and wrong for the filters an
 * operator works in all day — and it is why the Quote funnel's numbers could
 * not click through to the records behind them. "25 requests from the website"
 * had nowhere to point, because `/requests` had no way to arrive filtered.
 *
 * This is the TWO-WAY pattern, the one `Schedule.jsx` already uses for `?view=`
 * and `?date=`: read from the URL with a fallback, write on every change with
 * `replace: true` so a filter tweak doesn't stack a history entry you have to
 * back out of. Params are preserved, not clobbered — `?new=1` and friends still
 * work alongside.
 *
 * The repo also has a ONE-SHOT pattern (`useScheduleFilters`'s `?filter=`,
 * which applies once on mount then strips itself). That one is for a hand-off
 * where the URL should not keep describing the view afterwards. Not used here:
 * these filters ARE the view, and an operator who filters to "commercial leads"
 * and reloads should still be looking at commercial leads.
 *
 * A param equal to its default is omitted, so the common case has a clean URL
 * and `/requests` means "no filters" rather than "four filters set to all".
 *
 * `defaults` MUST be a stable reference — declare it as a module-level const,
 * not an inline literal, or the memo recomputes every render.
 *
 *   const FILTERS = { status: 'all', source: 'all' }
 *   const [filters, setFilter] = useUrlFilters(FILTERS)
 *   setFilter('source', 'website')      // → ?source=website
 *   setFilter('source', 'all')          // → param removed
 */
export function useUrlFilters(defaults) {
  const [params, setParams] = useSearchParams()

  const values = useMemo(() => {
    const out = {}
    for (const key of Object.keys(defaults)) {
      const raw = params.get(key)
      // An empty param is treated as absent: `?status=` is a URL that got
      // edited by hand or built by a loop, not a deliberate filter.
      out[key] = raw == null || raw === '' ? defaults[key] : raw
    }
    return out
  }, [params, defaults])

  const setFilter = useCallback((key, next) => {
    // Built from the CURRENT params rather than a functional update, matching
    // Schedule.jsx — react-router's functional form is newer than this repo's
    // floor, and filter changes arrive one at a time.
    const p = new URLSearchParams(params)
    if (next == null || next === '' || next === defaults[key]) p.delete(key)
    else p.set(key, String(next))
    setParams(p, { replace: true })
  }, [params, setParams, defaults])

  /** Clear every filter this hook owns, leaving unrelated params alone. */
  const clearFilters = useCallback(() => {
    const p = new URLSearchParams(params)
    for (const key of Object.keys(defaults)) p.delete(key)
    setParams(p, { replace: true })
  }, [params, setParams, defaults])

  const active = useMemo(
    () => Object.keys(defaults).some(k => values[k] !== defaults[k]),
    [values, defaults],
  )

  return [values, setFilter, { clearFilters, active }]
}

export default useUrlFilters
