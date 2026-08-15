import { ArrowRight, CheckCircle2, FileText } from 'lucide-react'
import { EmptyState } from '../ui'
import { Tile, TileLoading } from './primitives'
import { TONE } from './constants'

/** "Quotes & leads" tile — surfaces every kind of funnel item that needs
 *  the owner to do something next, one row per bucket:
 *   • Need a follow-up nudge
 *   • Changes requested
 *   • Awaiting customer response
 *   • Accepted — ready to schedule
 *   • New leads to quote
 *  Rows with a zero count are filtered out so the tile stays scannable;
 *  each row deep-links to the matching Quoting tab. */
export function QuotesLeadsTile({ loading, quoteActions, navigate }) {
  const rows = [
    { n: quoteActions.followUp,   label: 'Need a follow-up nudge',       tone: TONE.amber,   go: () => navigate('/billing?view=quotes&tab=follow-ups') },
    { n: quoteActions.changes,    label: 'Changes requested',            tone: TONE.amber,   go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.awaiting,   label: 'Awaiting customer response',   tone: TONE.blue,    go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.toSchedule, label: 'Accepted — ready to schedule', tone: TONE.emerald, go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.newLeads,   label: 'New leads to quote',           tone: TONE.purple,  go: () => navigate('/requests') },
  ]
  const anyActionable = rows.some(r => r.n > 0)
  return (
    <Tile
      icon={FileText}
      iconColor="text-purple-500"
      title="Quotes & leads"
      badge={(quoteActions.changes + quoteActions.newLeads) > 0 && (
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-3 tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
          {quoteActions.changes + quoteActions.newLeads}
        </span>
      )}
      action="Open Quoting"
      onAction={() => navigate('/billing?view=quotes&tab=quotes')}
    >
      {loading ? (
        <TileLoading />
      ) : !anyActionable ? (
        <EmptyState compact icon={CheckCircle2} title="Funnel clear"
          description="No quotes or leads waiting on you." />
      ) : (
        <div className="flex-1 space-y-1.5">
          {rows.filter(r => r.n > 0).map((r, i) => (
            <button key={i} onClick={r.go}
              className={`w-full flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-sm hover:opacity-90 transition-opacity ${r.tone}`}>
              <span className="truncate">{r.label}</span>
              <span className="font-bold shrink-0 flex items-center gap-1">{r.n} <ArrowRight className="w-3.5 h-3.5" /></span>
            </button>
          ))}
        </div>
      )}
    </Tile>
  )
}
