/**
 * Phone-only "+ New job" floating action button.
 *
 * Used to be a FULL-WIDTH bar pinned across the bottom of the agenda — it
 * covered the last card's content and the assistant button rode on top of
 * it (owner: "hate these big bubbles"). Now a compact pill in the
 * bottom-right, stacked ABOVE the PageAssistant/Ask-AI button (which sits
 * at bottom-[4.75rem] below lg) so the two never overlap, and narrow
 * enough that cards scroll past beside it.
 *
 * md:hidden — from tablet width up the toolbar's own "New Job" button is
 * the (one) primary; this exists only for one-thumb reach on phones.
 * Sits above the iOS home indicator via env(safe-area-inset-bottom).
 */
import { Plus } from 'lucide-react'

export default function StickyActionBar({ onNewJob }) {
  return (
    <button
      type="button"
      onClick={onNewJob}
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8.25rem)' }}
      className="no-print md:hidden fixed right-4 z-30 flex items-center gap-1.5 pl-3 pr-4 min-h-[44px] rounded-full text-[13px] font-semibold shadow-lg active:scale-95 transition-transform bg-indigo-600 text-white"
      aria-label="New job"
    >
      <Plus className="w-4 h-4" />
      <span>New job</span>
    </button>
  )
}
