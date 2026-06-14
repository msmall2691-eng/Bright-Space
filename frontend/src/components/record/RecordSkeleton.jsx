import { Skeleton } from '../ui'

/**
 * Loading placeholder for the Twenty-style 3-column record pages
 * (Opportunity / Job / Quote / Invoice). Mirrors their grid so the layout
 * doesn't jump when data arrives.
 */
export default function RecordSkeleton() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <Skeleton className="h-4 w-28 mb-4" />
        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* Left */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div className="flex items-center gap-2">
              <Skeleton className="w-10 h-10 rounded-lg" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
            <Skeleton className="h-5 w-40" />
            <div className="border-t border-hairline pt-3 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ))}
            </div>
          </div>
          {/* Center */}
          <div className="min-w-0 space-y-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
          {/* Right */}
          <div className="space-y-4 self-start">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
