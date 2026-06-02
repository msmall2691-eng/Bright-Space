/**
 * Skeleton — token-aware loading placeholder.
 *
 * Replaces ad-hoc `animate-pulse bg-gray-200` blocks (which don't theme) and
 * "Loading…" text. Compose freely, or use the helpers for common shapes.
 *
 *   <Skeleton className="h-8 w-40" />
 *   <SkeletonText lines={3} />
 *   <SkeletonCard />   // header + a few lines inside a Card-shaped surface
 */
export function Skeleton({ className = '' }) {
  return (
    <div className={`animate-pulse rounded-md bg-hairline/70 ${className}`} />
  )
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3.5 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </div>
  )
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={`bg-panel border border-hairline rounded-2xl p-4 ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-24" />
      </div>
      <SkeletonText lines={3} />
    </div>
  )
}

export default Skeleton
