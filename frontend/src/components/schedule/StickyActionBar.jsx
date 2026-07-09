/**
 * Mobile-only sticky bottom action bar.
 *
 * Consolidates the two most-common thumb-taps: primary "Assign crew · N"
 * when there are unassigned jobs today (falls back to "New job" when
 * there aren't), and a secondary `+` for the alternate action.
 *
 * Sits above the iOS home indicator via env(safe-area-inset-bottom). The
 * agenda list pads its bottom padding enough that no card gets hidden
 * behind this bar.
 */
import { Plus } from 'lucide-react'

export default function StickyActionBar({ unassignedCount, onAssign, onNewJob }) {
  const hasUnassigned = unassignedCount > 0
  return (
    <div
      className="lg:hidden fixed left-0 right-0 z-30 flex items-center gap-2 px-4"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 78px)' }}
    >
      <button
        type="button"
        onClick={hasUnassigned ? onAssign : onNewJob}
        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-full text-[14px] font-semibold shadow-lg active:scale-[0.99] transition-transform ${
          hasUnassigned
            ? 'bg-ink text-panel'
            : 'bg-blue-600 text-white'
        }`}
      >
        {hasUnassigned ? (
          <>
            <span>Assign crew</span>
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-amber-500 text-white text-[11px] font-mono tabular-nums">
              {unassignedCount}
            </span>
          </>
        ) : (
          <>
            <Plus className="w-4 h-4" />
            <span>New job</span>
          </>
        )}
      </button>
      {hasUnassigned && (
        <button
          type="button"
          onClick={onNewJob}
          className="w-11 h-11 grid place-items-center rounded-full bg-panel border border-hairline text-ink shadow-md active:scale-95 transition-transform"
          aria-label="New job"
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
