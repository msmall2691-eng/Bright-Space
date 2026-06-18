/**
 * Card — the standard token-aware surface.
 *
 * This is the shape repeated all over the app as
 * `bg-panel border border-hairline rounded-2xl` (Dashboard's Tile, Schedule's
 * cards, etc.). Centralizing it means one place controls radius, border, and
 * theming — unlike the older GlassCard, which hard-codes `bg-white/70` and
 * doesn't adapt to dark/alternate themes.
 *
 *   <Card>…</Card>
 *   <Card title="Today" icon={Calendar} action={<button>View</button>}>…</Card>
 *
 * Props:
 *  - title / subtitle / icon / iconColor — optional header row (with divider)
 *  - badge — small node rendered right after the title (e.g. a count pill)
 *  - action — node rendered right-aligned in the header row
 *  - padded — pad the body (default true); set false for edge-to-edge lists
 *  - as — element/component to render as (default "div"); use "section" etc.
 */
export default function Card({
  title,
  subtitle,
  icon: Icon,
  iconColor = 'text-ink-3',
  badge,
  action,
  padded = true,
  as: Tag = 'div',
  className = '',
  bodyClassName = '',
  children,
}) {
  const hasHeader = title || action
  return (
    <Tag className={`bg-panel border border-hairline rounded-2xl flex flex-col ${className}`}>
      {hasHeader && (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-hairline">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />}
            <div className="min-w-0">
              {title && (
                <h2 className="text-sm font-semibold text-ink truncate flex items-center gap-2">
                  {title}
                  {badge}
                </h2>
              )}
              {subtitle && <p className="text-[11px] text-ink-3 mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={`${padded ? 'p-3' : ''} ${bodyClassName}`}>{children}</div>
    </Tag>
  )
}
