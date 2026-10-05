import { ArrowRight } from 'lucide-react'

/**
 * A quiet summary box: a dot+word header with a right-aligned hand-off link,
 * and a few rows of {label, value, to}. Used for Home's Flow and Money columns
 * — both DERIVED from the board payload OpsBoard already fetched (no new
 * request). Each row is a record link into the page that owns the full list
 * (Flow / Billing). Renders nothing when there are no rows (no all-clear
 * furniture, per the owner's veto on empty boxes).
 */
export default function MiniListBox({ title, link, rows, navigate }) {
  if (!rows || !rows.length) return null
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel transition-colors hover:border-hairline-2">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</h2>
        {link && (
          <button onClick={() => navigate(link.to)}
            className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
            {link.label}<ArrowRight className="h-3 w-3" />
          </button>
        )}
      </header>
      <div className="divide-y divide-hairline">
        {rows.map(r => (
          <button key={r.label} onClick={() => navigate(r.to)}
            className="group flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2">
            {r.dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.dot}`} aria-hidden="true" />}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{r.label}</span>
            <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{r.value}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </section>
  )
}
