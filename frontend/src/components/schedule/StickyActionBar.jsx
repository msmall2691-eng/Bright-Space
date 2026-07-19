/**
 * Mobile-only sticky bottom action bar — just "+ New job".
 *
 * Used to swap its primary slot to a black "Assign crew · N" nag whenever
 * any job that day had no cleaner_ids — a small operator running its own
 * crew doesn't want that as the default action every time it opens the
 * agenda (production feedback), and it was floating on TOP of the last
 * card's content, compounding the "can't scroll to the bottom" bug fixed
 * alongside this. "New job" is always the primary action now; assigning a
 * crew still works the same as before via the job edit modal, it's just
 * not pushed on you here.
 *
 * Sits above the iOS home indicator via env(safe-area-inset-bottom). The
 * agenda list pads its bottom padding enough that no card gets hidden
 * behind this bar.
 */
import { Plus } from 'lucide-react'

export default function StickyActionBar({ onNewJob }) {
  return (
    <div
      className="no-print lg:hidden fixed left-0 right-0 z-30 flex items-center gap-2 px-4"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 78px)' }}
    >
      <button
        type="button"
        onClick={onNewJob}
        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-full text-[14px] font-semibold shadow-lg active:scale-[0.99] transition-transform bg-indigo-600 text-white"
      >
        <Plus className="w-4 h-4" />
        <span>New job</span>
      </button>
    </div>
  )
}
