import { Skeleton } from '../ui'

/**
 * Loading placeholder for ClientProfile — mirrors its actual shape (a fixed
 * left rail + quick-actions row + tab bar + tab content), not the generic
 * 3-column RecordSkeleton, since ClientProfile has no right column and a
 * mismatched skeleton would itself cause the layout jump it's meant to avoid.
 */
export default function ClientProfileSkeleton() {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail (desktop only, matches ClientLeftRail's lg:flex w-80) */}
      <aside className="hidden lg:flex lg:flex-col w-80 shrink-0 border-r border-hairline bg-panel p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="w-12 h-12 rounded-full" />
          <div className="space-y-1.5 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="border-t border-hairline pt-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0 h-full">
        {/* Quick actions row */}
        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 bg-panel/50 border-b border-hairline shrink-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-28 rounded-lg" />
          ))}
        </div>

        {/* Tab bar */}
        <div className="flex gap-4 border-b border-hairline px-4 sm:px-6 py-3 shrink-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-16" />
          ))}
        </div>

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}
