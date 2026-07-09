/**
 * Skeleton — token-aware loading placeholder.
 *
 * Replaces ad-hoc `animate-pulse bg-gray-200` blocks (which don't theme) and
 * "Loading…" text.
 *
 *   <Skeleton className="h-8 w-40" />
 *
 * Uses `opacity-70` rather than Tailwind's `bg-hairline/70` slash-opacity
 * modifier: `hairline` resolves to a plain `var(--hairline)` (not an
 * rgb-channel color), which the slash modifier can't blend against — it
 * silently produced a fully transparent (invisible) background.
 */
export function Skeleton({ className = '' }) {
  return (
    <div className={`animate-pulse rounded-md bg-hairline opacity-70 ${className}`} />
  )
}

export default Skeleton
