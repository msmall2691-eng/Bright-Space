import { useState, useEffect } from 'react'

/**
 * Tailwind-aware breakpoint hook (md = 768px by default). Returns a boolean
 * that toggles on window resize so components can switch layouts without a
 * full-page media query. Callers should treat this as "narrow viewport", not
 * "touch device" — it says nothing about pointer type.
 *
 * Extracted from CalendarView so the WeekGrid can share the same source of
 * truth for the mobile fallback (audit §7: don't ship a cramped 7-col grid
 * on phones).
 */
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < breakpoint
  )
  useEffect(() => {
    // Only setState when the boolean actually FLIPS across the breakpoint —
    // not on every resize event. This hook is mounted in Schedule, WeekGrid,
    // and CalendarView at once, so an undebounced setState on every resize
    // (and every drag-driven layout tick) stormed three components at 60fps.
    const onResize = () => {
      const next = window.innerWidth < breakpoint
      setIsMobile(prev => (prev === next ? prev : next))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return isMobile
}
