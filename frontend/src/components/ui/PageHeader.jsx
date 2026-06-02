/**
 * PageHeader — the standard top-of-page header.
 *
 * Replaces the hand-rolled `<h1>` + subtitle + actions blocks each page wrote
 * its own way (and often with hard-coded zinc colors that didn't theme). Uses
 * design tokens so it adapts to light / dark / alternate themes.
 *
 *   <PageHeader title="Invoices" subtitle="42 total" icon={FileText}
 *     actions={<Button>New invoice</Button>} />
 *
 * `actions` renders right-aligned on the same row; on narrow screens it wraps
 * underneath. `children` renders below the header row (e.g. a tabs strip).
 */
export default function PageHeader({
  title,
  subtitle,
  icon: Icon,
  iconColor = 'text-ink-3',
  actions,
  className = '',
  children,
}) {
  return (
    <div className={`px-4 sm:px-8 pt-6 sm:pt-7 pb-5 ${className}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <span className="shrink-0 mt-0.5">
              <Icon className={`w-5 h-5 ${iconColor}`} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs sm:text-[13px] text-ink-3 mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
