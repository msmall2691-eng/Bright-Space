/**
 * Crew UI primitives — the shared vocabulary of the phone app.
 *
 * Before this file, the card shell existed 8 times, the bottom-sheet scaffold
 * 9 times, the error box 18 times, and section headings came in three sizes —
 * each copy drifting a little. Build crew surfaces from these instead:
 *
 *   CrewCard        the panel card shell (was JobCard's local SOFT)
 *   SectionLabel    THE section heading (11px, uppercase, ink-3) — one size
 *   ErrorNote       quiet error: hairline card + red dot (no red-50 banner)
 *   DisclosureRow   inline expander row inside a card (checklist idiom)
 *   SettingRow      Me-tab accordion row: label + summary, expands in place
 *   Sheet           bottom sheet (phone) / centered (sm+) with backdrop
 *   SheetActions    the Cancel/confirm pair every sheet ends with
 *   FullScreenSheet full-screen page with the back-arrow header
 *
 * Styling follows the design language: no resting-state color fills; status
 * is a 6px dot + a plain word.
 */
import { useState } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'

/** The crew card shell class, for template-string call sites. */
export const SOFT = 'bg-panel rounded-xl border border-hairline shadow-glass-sm'

export function CrewCard({ className = '', children }) {
  return <div className={`${SOFT} ${className}`}>{children}</div>
}

/** One section-heading treatment for every crew surface. */
export function SectionLabel({ className = '', children }) {
  return (
    <h2 className={`text-[11px] font-semibold uppercase tracking-wide text-ink-3 ${className}`}>
      {children}
    </h2>
  )
}

/** Error display: hairline card + red dot + plain words. Renders nothing
 *  when there is no message, so call sites can pass state straight in. */
export function ErrorNote({ children, className = '' }) {
  if (!children) return null
  return (
    <div className={`flex items-start gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-2 ${className}`}>
      <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/** Inline expander INSIDE a card (the checklist idiom): a border-t row with
 *  label + optional count, chevron flips, children render in place — no
 *  fetch, no navigation. */
export function DisclosureRow({ icon: Icon, label, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5 min-w-0">
          {Icon && <Icon className="w-3.5 h-3.5 text-ink-3 shrink-0" />}
          <span className="truncate">{label}</span>
          {count != null && count !== '' && <span className="text-ink-3 shrink-0">· {count}</span>}
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

/** Me-tab accordion row: bold label + quiet summary line, expands in place.
 *  Children mount only when open — components that fetch on mount stay
 *  quiet until the cleaner actually opens them (crew payloads stay light). */
export function SettingRow({ icon: Icon, label, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full min-h-12 py-3 flex items-center justify-between gap-3 text-left active:opacity-70">
        <span className="flex items-center gap-2.5 min-w-0">
          {Icon && <Icon className="w-4 h-4 text-ink-3 shrink-0" />}
          <span className="min-w-0 leading-tight">
            <span className="block text-[13px] font-semibold text-ink">{label}</span>
            {summary && <span className="block text-[11px] text-ink-3 truncate mt-0.5">{summary}</span>}
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="pb-3.5">{children}</div>}
    </div>
  )
}

/** Bottom sheet on phones, centered dialog from sm: up. Tapping the backdrop
 *  closes unless `busy` (mid-save). Children own their content; the scaffold
 *  owns overlay, width, scroll containment, and padding. */
export function Sheet({ onClose, busy = false, wide = false, children }) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
      onClick={() => { if (!busy) onClose() }}>
      <div
        className={`w-full ${wide ? 'max-w-lg' : 'max-w-sm'} bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-4 max-h-[85dvh] overflow-y-auto overscroll-contain`}
        onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

const CONFIRM_TONES = {
  blue: 'bg-blue-600 hover:bg-blue-700',
  emerald: 'bg-emerald-600 hover:bg-emerald-700',
  amber: 'bg-amber-600 hover:bg-amber-700',
}

/** The Cancel / confirm pair every sheet ends with — one verb ("Cancel"),
 *  one busy treatment, tone picks the confirm color (default blue). */
export function SheetActions({
  onCancel, onConfirm, confirmLabel, busyLabel,
  busy = false, disabled = false, tone = 'blue', confirmIcon = null,
}) {
  return (
    <div className="flex gap-2">
      <button onClick={onCancel} disabled={busy}
        className="flex-1 text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
        Cancel
      </button>
      <button onClick={onConfirm} disabled={busy || disabled}
        className={`flex-1 text-[13px] font-semibold ${CONFIRM_TONES[tone] || CONFIRM_TONES.blue} text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-1.5`}>
        {confirmIcon}
        {busy ? (busyLabel || 'Saving…') : confirmLabel}
      </button>
    </div>
  )
}

/** Full-screen page with the back-arrow header (threads, readers, the house
 *  sheet). `flex` gives a column shell whose children manage their own
 *  scrolling (threads); default scrolls the whole page (readers). */
export function FullScreenSheet({ title, subtitle, onClose, flex = false, children }) {
  return (
    <div className={`fixed inset-0 z-30 bg-bg ${flex ? 'flex flex-col' : 'overflow-y-auto'}`}>
      <div className="sticky top-0 safe-top z-10 bg-panel/95 backdrop-blur border-b border-hairline px-4 py-3 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back"
          className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-ink leading-tight truncate">{title}</div>
          {subtitle && <div className="text-[11px] text-ink-3 truncate">{subtitle}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}
