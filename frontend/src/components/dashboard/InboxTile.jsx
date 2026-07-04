import { CheckCircle2, Inbox } from 'lucide-react'
import { EmptyState } from '../ui'
import { AttentionRow, Tile, TileLoading } from './primitives'

/** "Inbox needs attention" tile.
 *
 *  Shows a dedupe'd list of items that need action: overdue / unassigned
 *  conversations, late visits, and past-due invoices. The Comms icon
 *  chip pill-badges any SLA-breached count (red) and total attention
 *  count (grey).
 *
 *  Per-category "+N more" overflow rows route to the page where those
 *  items actually live — /comms doesn't surface late visits or overdue
 *  invoices, so each category CTA points to its own home. */
export function InboxTile({
  loading,
  attention,
  slaBreached,
  hiddenOverdueConvs,
  hiddenUnassignedConvs,
  hiddenLateVisits,
  hiddenInvoices,
  navigate,
}) {
  return (
    <Tile
      icon={Inbox}
      iconColor="text-blue-500"
      title="Inbox needs attention"
      badge={(attention.length > 0 || slaBreached > 0) && (
        <span className="flex items-center gap-1">
          {slaBreached > 0 && (
            <span className="text-[10px] font-bold text-white bg-red-500 px-1.5 py-0.5 rounded-full" title="Conversations past their response SLA">
              {slaBreached} SLA
            </span>
          )}
          {attention.length > 0 && (
            <span className="text-[10px] font-bold text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded-full">
              {attention.length}
            </span>
          )}
        </span>
      )}
      action="Open Comms"
      onAction={() => navigate('/comms')}
    >
      {loading ? (
        <TileLoading />
      ) : attention.length === 0 ? (
        <EmptyState compact icon={CheckCircle2} title="All clear"
          description="Nothing urgent right now." />
      ) : (
        <div className="flex-1 overflow-y-auto max-h-[380px]">
          {attention.map(p => (
            <AttentionRow key={p.key} {...p} />
          ))}
          {/* Per-category overflow: route each "+N more" to the page
              where those items actually live. /comms doesn't surface
              late visits or overdue invoices, so the CTA needs to
              match the category. */}
          {(hiddenOverdueConvs + hiddenUnassignedConvs > 0) && (
            <button
              onClick={() => navigate('/comms')}
              className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
            >
              +{hiddenOverdueConvs + hiddenUnassignedConvs} more in inbox · Open Comms →
            </button>
          )}
          {hiddenLateVisits > 0 && (
            <button
              onClick={() => navigate('/schedule')}
              className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
            >
              +{hiddenLateVisits} more late {hiddenLateVisits === 1 ? 'visit' : 'visits'} · Open Schedule →
            </button>
          )}
          {hiddenInvoices > 0 && (
            <button
              onClick={() => navigate('/billing?view=invoices')}
              className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
            >
              +{hiddenInvoices} more past-due {hiddenInvoices === 1 ? 'invoice' : 'invoices'} · Open Invoicing →
            </button>
          )}
        </div>
      )}
    </Tile>
  )
}
