/**
 * StatCard — a single metric cell (label / value / sub).
 *
 * The pattern behind Invoicing's metrics bar and Dashboard's MoneyStat. Token-
 * aware, optionally clickable. Group several in a grid for a metrics strip.
 *
 *   <StatCard label="Outstanding" value="$1,240" sub="3 invoices"
 *     accent="text-amber-600" onClick={…} />
 */
export default function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = 'text-ink',
  onClick,
  className = '',
}) {
  const interactive = typeof onClick === 'function'
  const Tag = interactive ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={`text-left p-4 ${
        interactive ? 'hover:bg-bg active:bg-bg-2 transition-colors cursor-pointer' : ''
      } ${className}`}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="w-3.5 h-3.5 text-ink-3" />}
        <span className="text-[10px] font-semibold text-ink-3 uppercase tracking-[0.14em]">
          {label}
        </span>
      </div>
      <div className={`text-xl sm:text-2xl font-bold mt-1.5 tabular-nums ${accent}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-3 mt-1">{sub}</div>}
    </Tag>
  )
}
