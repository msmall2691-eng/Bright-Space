import { ArrowRight, CheckCircle2, FileText } from 'lucide-react'
import { EmptyState } from '../ui'
import { Tile, TileLoading } from './primitives'

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
    { n: quoteActions.followUp,   label: 'Need a follow-up nudge',       tone: 'text-amber-700 bg-amber-50 border-amber-200',       go: () => navigate('/billing?view=quotes&tab=follow-ups') },
    { n: quoteActions.changes,    label: 'Changes requested',            tone: 'text-amber-700 bg-amber-50 border-amber-200',       go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.awaiting,   label: 'Awaiting customer response',   tone: 'text-blue-700 bg-blue-50 border-blue-200',          go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.toSchedule, label: 'Accepted — ready to schedule', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', go: () => navigate('/billing?view=quotes&tab=quotes') },
    { n: quoteActions.newLeads,   label: 'New leads to quote',           tone: 'text-purple-700 bg-purple-50 border-purple-200',    go: () => navigate('/billing?view=quotes&tab=leads') },
  ]
  const anyActionable = rows.some(r => r.n > 0)
  return (
    <Tile
      icon={FileText}
      iconColor="text-purple-500"
      title="Quotes & leads"
      badge={(quoteActions.changes + quoteActions.newLeads) > 0 && (
        <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
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
