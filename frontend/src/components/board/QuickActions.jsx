import { FileText, CalendarDays, MessageSquare, Inbox, Receipt, StickyNote } from 'lucide-react'
import { currentRole } from '../../nav/routes'

/**
 * Quick actions on Home — one-tap tiles for the things the owner starts most.
 *
 * Each tile deep-links to the page that owns the create flow with the param
 * that auto-opens its form (?new=1 / ?compose=1) — the same links the global
 * "+ New" menu uses, so they can't drift. "Quick note" is the one exception:
 * it fires a window event the StickyNotes widget listens for, so a note appears
 * without leaving Home. Office-only (every create flow is an admin/manager
 * write), so it renders nothing for a viewer/cleaner.
 */
const ACTIONS = [
  { label: 'New quote', icon: FileText, to: '/quotes?new=1' },
  { label: 'New job', icon: CalendarDays, to: '/schedule?new=1' },
  { label: 'Text a client', icon: MessageSquare, to: '/comms?compose=1' },
  { label: 'Add lead', icon: Inbox, to: '/requests?new=1' },
  { label: 'New invoice', icon: Receipt, to: '/billing?view=invoices&new=1' },
  { label: 'Quick note', icon: StickyNote, event: 'bb:add-note' },
]

export default function QuickActions({ navigate }) {
  const role = currentRole()
  if (role !== 'admin' && role !== 'manager') return null

  const run = (a) => {
    if (a.event) { try { window.dispatchEvent(new CustomEvent(a.event)) } catch { /* no-op */ } return }
    navigate(a.to)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel" data-testid="home-quick-actions">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none" aria-hidden="true">⚡</span>
        <h2 className="text-[11px] font-medium text-ink-3">Quick actions</h2>
      </header>
      <div className="p-2.5">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ACTIONS.map(a => (
            <button key={a.label} onClick={() => run(a)} data-testid={`qa-${a.label}`}
              className="flex flex-col items-center gap-2 rounded-xl border border-hairline bg-bg-2/40 px-2 py-3 text-ink-2 transition-colors hover:border-indigo-500 hover:bg-indigo-500/5 hover:text-ink">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-hairline bg-panel">
                <a.icon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              </span>
              <span className="text-center text-[11px] font-semibold leading-tight">{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
