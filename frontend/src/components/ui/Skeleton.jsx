/**
 * Skeleton — token-aware loading placeholder.
 *
 * Replaces ad-hoc `animate-pulse bg-gray-200` blocks (which don't theme) and
 * "Loading…" text.
 *
 *   <Skeleton className="h-8 w-40" />
 */
export function Skeleton({ className = '' }) {
  return (
    <div className={`animate-pulse rounded-md bg-hairline/70 ${className}`} />
  )
}

export default Skeleton
